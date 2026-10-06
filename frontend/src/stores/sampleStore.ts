/**
 * 采集与离散率状态（Zustand）
 * 维护采集记录、辐照度补全结果、按组串聚合的离散率派生榜、人工标记的可疑组串集合。
 *
 * 复核口径：
 * - 云影等异常读数通过「不计入统计」开关剔除，原始记录保留可查看，可随时恢复；
 * - 离散率榜与失配数只按剩余（countedInStats）读数重算；
 * - 辐照度缺失时先取同次同汇流箱其他组串实测中位数，整箱都缺再沿用本组串上一条有效值，
 *   沿用间隔超过 30 分钟的读数退出统计（记录保留），避免来源选错误报失配。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  getThresholds,
  listInverters,
  listPlants,
  listArrays,
  listSamples,
  listStrings,
  putSample,
  putSamples,
  removeSample,
  type InverterRow,
  type PlantRow,
  type ArrayRow as DbArrayRow,
  type SampleRow,
  type StringRow,
} from '../utils/db';
import type {
  IrradianceSource,
  SampleDraft,
  SampleRow as SampleViewRow,
  StringDiscreteStat,
} from '../types/sample';
import { SAMPLE_EXCLUDE_REASON_LABEL } from '../types/sample';
import type { ThresholdConfig } from '../types/settings';
import { DEFAULT_THRESHOLDS } from '../types/settings';
import { buildStringStats, normalizeCurrent, type StatSample } from '../utils/discrete';
import {
  resolveIrradianceBatch,
  type IrradianceOwner,
  type ResolvedIrradiance,
} from '../utils/irradiance';
import { normalizeIrradianceInput } from '../utils/irradiance';
import { nowIso, uuid } from '../utils/format';
import { emitChange, subscribeChange } from '../utils/events';

/** 携带补全信息的采集行（库行 + 辐照度解析结果 + 统计口径） */
export type EnrichedSampleRow = SampleRow & {
  effectiveIrradianceWm2: number;
  irradianceSource: IrradianceSource;
  countedInStats: boolean;
  uncountedReason: string | null;
};

interface SampleStoreState {
  samples: SampleRow[];
  strings: StringRow[];
  inverters: InverterRow[];
  arrays: DbArrayRow[];
  plants: PlantRow[];
  stats: StringDiscreteStat[];
  thresholds: ThresholdConfig;
  /** 人工标记的可疑组串（跨页共享，排查台与采集页同步） */
  markedStringIds: string[];
  loading: boolean;
  error: string;
  loadSamples: () => Promise<void>;
  subscribe: () => void;
  setThresholds: (config: ThresholdConfig) => void;
  addSample: (draft: SampleDraft) => Promise<SampleRow>;
  addBatchSamples: (drafts: SampleDraft[]) => Promise<number>;
  updateSample: (sampleId: string, draft: SampleDraft) => Promise<void>;
  deleteSample: (sampleId: string) => Promise<void>;
  deleteSamplesOfString: (stringId: string) => Promise<void>;
  /** 设置某条读数是否计入统计（剔除 / 恢复，原始记录始终保留） */
  setSampleExcluded: (sampleId: string, excluded: boolean, reason?: string) => Promise<void>;
  toggleMark: (stringId: string) => void;
  markMany: (stringIds: string[]) => void;
  clearMarks: () => void;
  sampleRows: () => SampleViewRow[];
  samplesOfString: (stringId: string) => SampleRow[];
  statsOfString: (stringId: string) => StringDiscreteStat | null;
  suspiciousStats: () => StringDiscreteStat[];
  /** 重新计算并落库某组串（实际重算同汇流箱全部组串）的离散率，返回目标组串最新离散率 */
  recalcDiscreteRate: (stringId: string) => Promise<number>;
}

/** stringId → 所属逆变器/汇流箱 */
function buildOwners(strings: StringRow[]): Map<string, IrradianceOwner> {
  const map = new Map<string, IrradianceOwner>();
  for (const item of strings) {
    map.set(item.id, { stringId: item.id, inverterId: item.inverterId, combinerBox: item.combinerBox });
  }
  return map;
}

/** 统一解析辐照度补全结果（同箱中位数 → 上一条有效值，超 30 分钟退出统计） */
function enrich(
  samples: SampleRow[],
  strings: StringRow[],
): { rows: EnrichedSampleRow[]; resolved: Map<string, ResolvedIrradiance> } {
  const owners = buildOwners(strings);
  const resolved = resolveIrradianceBatch(samples, owners);
  const rows: EnrichedSampleRow[] = samples.map((sample) => {
    const info = resolved.get(sample.id) ?? {
      effectiveIrradianceWm2: 0,
      source: 'none' as IrradianceSource,
      fresh: false,
    };
    const excluded = sample.excludedFromStats === true;
    const counted = !excluded && info.source !== 'none' && info.fresh;
    return {
      ...sample,
      effectiveIrradianceWm2: info.effectiveIrradianceWm2,
      irradianceSource: info.source,
      countedInStats: counted,
      uncountedReason: excluded
        ? sample.excludeReason ?? SAMPLE_EXCLUDE_REASON_LABEL.other
        : info.source === 'none'
          ? '辐照度缺失且无可用补全来源'
          : !info.fresh
            ? '补全辐照度距采集已超过 30 分钟，退出统计'
            : null,
    };
  });
  return { rows, resolved };
}

function toStatSamples(enrichedRows: EnrichedSampleRow[]): StatSample[] {
  return enrichedRows.map((row) => ({
    id: row.id,
    stringId: row.stringId,
    sampledAt: row.sampledAt,
    currentA: row.currentA,
    voltageV: row.voltageV,
    irradianceWm2: row.irradianceWm2,
    discreteRate: row.discreteRate,
    excludedFromStats: row.excludedFromStats,
    excludeReason: row.excludeReason,
    createdAt: row.createdAt,
    effectiveIrradianceWm2: row.effectiveIrradianceWm2,
    countedInStats: row.countedInStats,
    uncountedReason: row.uncountedReason,
  }));
}

function hydrateStats(
  enrichedRows: EnrichedSampleRow[],
  strings: StringRow[],
  inverters: InverterRow[],
  arrays: DbArrayRow[],
  plants: PlantRow[],
  thresholds: ThresholdConfig,
): StringDiscreteStat[] {
  const base = buildStringStats(toStatSamples(enrichedRows), thresholds);
  return base.map((stat) => {
    const owner = strings.find((item) => item.id === stat.stringId);
    const inverter = owner ? inverters.find((item) => item.id === owner.inverterId) : undefined;
    const array = inverter ? arrays.find((item) => item.id === inverter.arrayId) : undefined;
    const plant = array ? plants.find((item) => item.id === array.plantId) : undefined;
    return {
      ...stat,
      stringCode: owner?.code ?? '已删除组串',
      combinerBox: owner?.combinerBox ?? '-',
      inverterId: inverter?.id ?? '',
      arrayId: array?.id ?? '',
      plantId: plant?.id ?? '',
    };
  });
}

let unsubscribed: (() => void) | null = null;

export const useSampleStore = create<SampleStoreState>((set, get) => ({
  samples: [],
  strings: [],
  inverters: [],
  arrays: [],
  plants: [],
  stats: [],
  thresholds: DEFAULT_THRESHOLDS,
  markedStringIds: [],
  loading: false,
  error: '',

  async loadSamples() {
    set({ loading: true });
    try {
      const [samples, strings, inverters, arrays, plants, thresholdRow] = await Promise.all([
        listSamples(),
        listStrings(),
        listInverters(),
        listArrays(),
        listPlants(),
        getThresholds(),
      ]);
      const thresholds: ThresholdConfig = { ...thresholdRow };
      const { rows: enrichedRows } = enrich(samples, strings);
      set((state) => ({
        samples,
        strings,
        inverters,
        arrays,
        plants,
        thresholds,
        stats: hydrateStats(enrichedRows, strings, inverters, arrays, plants, thresholds),
        loading: false,
        error: '',
        markedStringIds: state.markedStringIds.filter((id) =>
          strings.some((item) => item.id === id),
        ),
      }));
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '采集数据读取失败' });
    }
  },

  subscribe() {
    if (unsubscribed) return;
    unsubscribed = subscribeChange(() => {
      void get().loadSamples();
    });
  },

  setThresholds(config) {
    set((state) => {
      const { rows: enrichedRows } = enrich(state.samples, state.strings);
      return {
        thresholds: config,
        stats: hydrateStats(enrichedRows, state.strings, state.inverters, state.arrays, state.plants, config),
      };
    });
  },

  async addSample(draft) {
    const row: SampleRow = {
      id: uuid(),
      stringId: draft.stringId,
      sampledAt: draft.sampledAt,
      currentA: draft.currentA,
      voltageV: draft.voltageV,
      irradianceWm2: normalizeIrradianceInput(draft.irradianceWm2),
      discreteRate: 0,
      excludedFromStats: false,
      excludeReason: null,
      createdAt: nowIso(),
      revision: ROW_REVISION,
    };
    await putSample(row);
    // 先落库再依据含新点的完整序列重算离散率并回写
    await get().recalcDiscreteRate(draft.stringId);
    emitChange();
    return row;
  },

  async addBatchSamples(drafts) {
    const rows: SampleRow[] = [];
    for (const draft of drafts) {
      rows.push({
        id: uuid(),
        stringId: draft.stringId,
        sampledAt: draft.sampledAt,
        currentA: draft.currentA,
        voltageV: draft.voltageV,
        irradianceWm2: normalizeIrradianceInput(draft.irradianceWm2),
        discreteRate: 0,
        excludedFromStats: false,
        excludeReason: null,
        createdAt: nowIso(),
        revision: ROW_REVISION,
      });
    }
    if (rows.length === 0) return 0;
    await putSamples(rows);
    // 批量落库后统一重算受影响组串（同汇流箱口径）的离散率
    const affected = [...new Set(rows.map((row) => row.stringId))];
    for (const stringId of affected) {
      await get().recalcDiscreteRate(stringId);
    }
    emitChange();
    return rows.length;
  },

  async updateSample(sampleId, draft) {
    const existing = get().samples.find((item) => item.id === sampleId);
    if (!existing) return;
    await putSample({
      ...existing,
      stringId: draft.stringId,
      sampledAt: draft.sampledAt,
      currentA: draft.currentA,
      voltageV: draft.voltageV,
      irradianceWm2: normalizeIrradianceInput(draft.irradianceWm2),
    });
    await get().recalcDiscreteRate(draft.stringId);
    if (draft.stringId !== existing.stringId) await get().recalcDiscreteRate(existing.stringId);
    emitChange();
  },

  async deleteSample(sampleId) {
    const existing = get().samples.find((item) => item.id === sampleId);
    await removeSample(sampleId);
    if (existing) await get().recalcDiscreteRate(existing.stringId);
    emitChange();
  },

  async deleteSamplesOfString(stringId) {
    const rows = get().samples.filter((item) => item.stringId === stringId);
    for (const row of rows) {
      await removeSample(row.id);
    }
    emitChange();
  },

  async setSampleExcluded(sampleId, excluded, reason) {
    const existing = get().samples.find((item) => item.id === sampleId);
    if (!existing) return;
    await putSample({
      ...existing,
      excludedFromStats: excluded,
      // 恢复计入时保留历史原因备注，仅关闭开关；剔除时未给原因则用默认文案
      excludeReason: excluded
        ? reason?.trim() || existing.excludeReason || SAMPLE_EXCLUDE_REASON_LABEL.cloud
        : existing.excludeReason,
    });
    // 离散率榜与失配数按剩余读数重算（同汇流箱统一口径）
    await get().recalcDiscreteRate(existing.stringId);
    emitChange();
  },

  toggleMark(stringId) {
    set((state) => ({
      markedStringIds: state.markedStringIds.includes(stringId)
        ? state.markedStringIds.filter((id) => id !== stringId)
        : [...state.markedStringIds, stringId],
    }));
  },

  markMany(stringIds) {
    set((state) => ({ markedStringIds: [...new Set([...state.markedStringIds, ...stringIds])] }));
  },

  clearMarks() {
    set({ markedStringIds: [] });
  },

  sampleRows() {
    const { samples, strings, inverters, arrays, plants, thresholds } = get();
    const { rows: enrichedRows } = enrich(samples, strings);
    return enrichedRows.map((sample) => {
      const owner = strings.find((item) => item.id === sample.stringId);
      const inverter = owner ? inverters.find((item) => item.id === owner.inverterId) : undefined;
      const array = inverter ? arrays.find((item) => item.id === inverter.arrayId) : undefined;
      const plant = array ? plants.find((item) => item.id === array.plantId) : undefined;
      return {
        ...sample,
        stringCode: owner?.code ?? '已删除组串',
        combinerBox: owner?.combinerBox ?? '-',
        inverterId: inverter?.id ?? '',
        inverterModel: inverter?.model ?? '-',
        arrayId: array?.id ?? '',
        arrayCode: array?.code ?? '-',
        plantId: plant?.id ?? '',
        plantName: plant?.name ?? '未归属电站',
        normalizedCurrentA: normalizeCurrent(sample.currentA, sample.effectiveIrradianceWm2, thresholds),
      };
    });
  },

  samplesOfString(stringId) {
    return get()
      .samples.filter((item) => item.stringId === stringId)
      .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  },

  statsOfString(stringId) {
    return get().stats.find((item) => item.stringId === stringId) ?? null;
  },

  suspiciousStats() {
    return get().stats.filter((item) => item.level === 'mismatch' || item.level === 'watch');
  },

  async recalcDiscreteRate(stringId) {
    const { strings, samples } = get();
    const owner = strings.find((item) => item.id === stringId);
    if (!owner) return 0;
    const peers = strings.filter(
      (item) => item.inverterId === owner.inverterId && item.combinerBox === owner.combinerBox,
    );
    const peerIds = new Set(peers.map((item) => item.id));
    const scope = samples.length > 0 ? samples : await listSamples();
    const targets = scope.filter((item) => peerIds.has(item.stringId));
    if (targets.length === 0) return 0;

    // 与榜单完全一致的口径：补全辐照度 → 仅按计入统计的读数聚合
    const { rows: enrichedRows } = enrich(scope, strings);
    const boxStats = buildStringStats(toStatSamples(enrichedRows), get().thresholds);
    const rateByString = new Map(boxStats.map((stat) => [stat.stringId, stat.discreteRate]));
    const countedByString = new Set(enrichedRows.filter((row) => row.countedInStats).map((row) => row.id));
    await Promise.all(
      targets.map((item) =>
        putSample({
          ...item,
          discreteRate: countedByString.has(item.id) ? (rateByString.get(item.stringId) ?? 0) : 0,
        }),
      ),
    );
    return rateByString.get(stringId) ?? 0;
  },
}));
