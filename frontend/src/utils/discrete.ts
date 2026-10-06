/**
 * 离散率计算与判定
 * 离散率 = 标准差 / 均值 × 100%，衡量同一汇流箱内组串电流的一致性。
 * 纯函数，供采集页、排查工作台与处置单页共用。
 * 统计口径：仅计入「未人工剔除 + 辐照度有效」的读数（isSampleCountable）。
 */
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from '../types/settings';
import {
  isSampleCountable,
  type DiscreteLevel,
  type IrradianceSource,
  type Sample,
  type StringDiscreteStat,
} from '../types/sample';
import { round } from './format';

/** 均值 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 中位数（偶数个取中间两值平均），空数组返回 0 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 样本标准差（n-1），样本数 < 2 时返回 0 */
export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** 离散率（%）= 标准差 / 均值 × 100 */
export function discreteRate(values: number[]): number {
  const avg = mean(values);
  if (avg <= 0) return 0;
  return round((stdDev(values) / avg) * 100, 2);
}

/** 电流归一化修正：把实测电流折算到标准辐照度下，消除云影/时段影响；辐照度缺失时不做修正 */
export function normalizeCurrent(
  currentA: number,
  irradianceWm2: number | null,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): number {
  if (irradianceWm2 === null || irradianceWm2 <= 0) return round(currentA, 3);
  const ratio = config.standardIrradiance / irradianceWm2;
  // 辐照度极低时归一化会放大噪声，限制修正倍数上限为 2
  return round(currentA * Math.min(ratio, 2), 3);
}

/** 辐照度解析结果：归一化使用的有效辐照度与来源 */
export interface IrradianceResolution {
  effective: number | null;
  source: IrradianceSource;
}

/** 采集时间字符串（yyyy-MM-dd HH:mm）→ 毫秒时间戳，非法返回 NaN */
function sampledAtMs(sampledAt: string): number {
  return new Date(sampledAt.replace(' ', 'T')).getTime();
}

/**
 * 解析同一汇流箱范围内每条读数的有效辐照度与来源（优先级固定，来源选错会误报失配）：
 * 1. 实测值（irradianceWm2 > 0）→ measured
 * 2. 缺测时取同次（同 sampledAt）同汇流箱其他组串实测辐照度的中位数 → boxMedian
 * 3. 整箱都缺时沿用上一条有效值（本组串时间序列上最近的实测值）→ carried
 * 4. 上一条有效值距本次超过 carryLimitMin 分钟 → missing（该读数退出统计）
 */
export function resolveIrradianceSources<
  T extends Pick<Sample, 'id' | 'stringId' | 'sampledAt' | 'irradianceWm2'>,
>(samples: T[], carryLimitMin: number): Map<string, IrradianceResolution> {
  const result = new Map<string, IrradianceResolution>();
  const measuredOf = (item: T): number | null =>
    typeof item.irradianceWm2 === 'number' && item.irradianceWm2 > 0 ? item.irradianceWm2 : null;

  // 同次读数分组：组内其他组串的实测辐照度作为中位数来源池
  const byTime = new Map<string, T[]>();
  for (const item of samples) {
    const list = byTime.get(item.sampledAt);
    if (list) list.push(item);
    else byTime.set(item.sampledAt, [item]);
  }

  // 本组串按时间升序的实测历史，用于「沿用上一条有效值」
  const measuredHistory = new Map<string, Array<{ at: number; value: number }>>();
  for (const item of samples) {
    const value = measuredOf(item);
    if (value === null) continue;
    const list = measuredHistory.get(item.stringId) ?? [];
    list.push({ at: sampledAtMs(item.sampledAt), value });
    measuredHistory.set(item.stringId, list);
  }
  for (const list of measuredHistory.values()) {
    list.sort((a, b) => a.at - b.at);
  }

  for (const item of samples) {
    const own = measuredOf(item);
    if (own !== null) {
      result.set(item.id, { effective: own, source: 'measured' });
      continue;
    }
    // 同次同箱其他组串的实测辐照度中位数
    const peers = (byTime.get(item.sampledAt) ?? [])
      .filter((peer) => peer.stringId !== item.stringId)
      .map((peer) => measuredOf(peer))
      .filter((value): value is number => value !== null);
    if (peers.length > 0) {
      result.set(item.id, { effective: round(median(peers), 1), source: 'boxMedian' });
      continue;
    }
    // 整箱都缺：沿用本组串上一条有效值，超过时限则退出统计
    const history = measuredHistory.get(item.stringId) ?? [];
    const at = sampledAtMs(item.sampledAt);
    const previous = [...history].reverse().find((entry) => entry.at < at);
    const gapMin = previous && Number.isFinite(at) ? (at - previous.at) / 60000 : Infinity;
    if (previous && gapMin <= carryLimitMin) {
      result.set(item.id, { effective: previous.value, source: 'carried' });
    } else {
      result.set(item.id, { effective: null, source: 'missing' });
    }
  }
  return result;
}

/** 离散率档位判定 */
export function levelOf(rate: number, config: ThresholdConfig = DEFAULT_THRESHOLDS): DiscreteLevel {
  if (rate >= config.discreteAlarmRate) return 'mismatch';
  if (rate >= config.discreteWatchRate) return 'watch';
  return 'normal';
}

/** 电流偏差百分比：相对基准值（同汇流箱均值）的偏离 */
export function currentBiasPercent(value: number, baseline: number): number {
  if (baseline <= 0) return 0;
  return round(((value - baseline) / baseline) * 100, 2);
}

/** 取读数用于归一化的有效辐照度（优先落库的解析值，兼容历史行回退原始读数） */
export function effectiveIrradianceOf(
  sample: Pick<Sample, 'irradianceWm2' | 'effectiveIrradianceWm2'>,
): number | null {
  return sample.effectiveIrradianceWm2 ?? sample.irradianceWm2 ?? null;
}

/**
 * 按汇流箱分组现场解析全部读数的有效辐照度与来源，返回带最新解析结果的样本副本。
 * 统计口径以此为准（阈值如沿用时限调整后立即生效）；落库的解析字段仅作追溯快照。
 */
export function applyIrradianceResolution<T extends Sample>(
  samples: T[],
  strings: Array<{ id: string; inverterId: string; combinerBox: string }>,
  carryLimitMin: number,
): T[] {
  const boxOf = new Map(
    strings.map((item) => [item.id, `${item.inverterId}::${item.combinerBox}`] as const),
  );
  const groups = new Map<string, T[]>();
  for (const sample of samples) {
    const key = boxOf.get(sample.stringId) ?? '__unknown__';
    const list = groups.get(key);
    if (list) list.push(sample);
    else groups.set(key, [sample]);
  }
  const output: T[] = [];
  for (const group of groups.values()) {
    const resolved = resolveIrradianceSources(group, carryLimitMin);
    for (const item of group) {
      const resolution = resolved.get(item.id);
      output.push({
        ...item,
        irradianceSource: resolution?.source ?? item.irradianceSource,
        effectiveIrradianceWm2: resolution?.effective ?? item.effectiveIrradianceWm2 ?? null,
      });
    }
  }
  return output;
}

/** 按时间序列计算某组串的离散率（逐点滚动均值法，取最后一个窗口作为当前离散率） */
export function rollingDiscreteRate(samples: Sample[], windowSize = 5): number {
  const countable = samples.filter((item) => isSampleCountable(item));
  if (countable.length === 0) return 0;
  const sorted = [...countable].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  const window = sorted.slice(-Math.max(2, windowSize));
  return discreteRate(window.map((item) => normalizeCurrent(item.currentA, effectiveIrradianceOf(item))));
}

/** 分组键：同一逆变器 + 同一汇流箱视为一个可比对集合 */
export function groupKeyOf(row: { inverterId: string; combinerBox: string }): string {
  return `${row.inverterId}::${row.combinerBox}`;
}

/**
 * 由采集记录聚合出组串离散率榜。
 * 同一汇流箱内的组串电流互为基准，逐组串计算离散率与电流偏差。
 * 只统计「计入开关开 + 辐照度有效」的读数；被剔除 / 缺测退出的读数保留在库但不参与。
 */
export function buildStringStats(
  samples: Sample[],
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): StringDiscreteStat[] {
  const grouped = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = grouped.get(sample.stringId);
    if (list) list.push(sample);
    else grouped.set(sample.stringId, [sample]);
  }

  interface Draft {
    stringId: string;
    values: number[];
    raws: number[];
    lastSampledAt: string;
    count: number;
    excludedCount: number;
  }

  const drafts: Draft[] = [];
  for (const [stringId, list] of grouped) {
    const countable = list.filter((item) => isSampleCountable(item));
    const sorted = [...countable].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
    const window = sorted.slice(-8);
    drafts.push({
      stringId,
      values: window.map((item) => normalizeCurrent(item.currentA, effectiveIrradianceOf(item), config)),
      raws: window.map((item) => item.currentA),
      lastSampledAt: sorted[sorted.length - 1]?.sampledAt ?? '',
      count: countable.length,
      excludedCount: list.length - countable.length,
    });
  }

  const stats: StringDiscreteStat[] = drafts.map((draft) => ({
    stringId: draft.stringId,
    stringCode: '',
    combinerBox: '',
    inverterId: '',
    arrayId: '',
    plantId: '',
    sampleCount: draft.count,
    excludedCount: draft.excludedCount,
    avgCurrentA: round(mean(draft.raws), 2),
    avgNormalizedCurrentA: round(mean(draft.values), 3),
    discreteRate: discreteRate(draft.values),
    currentBiasPercent: 0,
    level: 'normal',
    lastSampledAt: draft.lastSampledAt,
  }));

  // 逐集合（汇流箱）计算相对偏差与最终档位
  const buckets = new Map<string, StringDiscreteStat[]>();
  for (const stat of stats) {
    const key = stat.inverterId ? groupKeyOf(stat) : stat.stringId.slice(0, 0) + '__pending';
    const list = buckets.get(key);
    if (list) list.push(stat);
    else buckets.set(key, [stat]);
  }

  const globalBaseline = mean(stats.map((item) => item.avgNormalizedCurrentA));
  for (const stat of stats) {
    const baseline = globalBaseline > 0 ? globalBaseline : stat.avgNormalizedCurrentA;
    stat.currentBiasPercent = currentBiasPercent(stat.avgNormalizedCurrentA, baseline);
    const tooFew = stat.sampleCount < config.minSampleCount;
    const badByRate = levelOf(stat.discreteRate, config);
    const badByBias =
      Math.abs(stat.currentBiasPercent) >= config.currentBiasPercent ? 'mismatch' : 'normal';
    const level: DiscreteLevel =
      badByRate === 'mismatch' || badByBias === 'mismatch'
        ? 'mismatch'
        : badByRate === 'watch'
          ? 'watch'
          : tooFew
            ? 'watch'
            : 'normal';
    stat.level = level;
  }

  return stats;
}

/** 在当前集合内重新计算偏差（供 UI 对指定汇流箱分组时调用） */
export function rebaseBias(
  stats: StringDiscreteStat[],
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): StringDiscreteStat[] {
  if (stats.length === 0) return [];
  const baseline = mean(stats.map((item) => item.avgNormalizedCurrentA));
  return stats.map((stat) => {
    const bias = currentBiasPercent(stat.avgNormalizedCurrentA, baseline);
    const byBias = Math.abs(bias) >= config.currentBiasPercent;
    const level: DiscreteLevel = byBias
      ? 'mismatch'
      : stat.level === 'mismatch'
        ? 'mismatch'
        : levelOf(stat.discreteRate, config);
    return { ...stat, currentBiasPercent: bias, level };
  });
}

/** 离散率 → 颜色（供表格内联样式复用） */
export const DISCRETE_COLOR: Record<DiscreteLevel, string> = {
  normal: '#237804',
  watch: '#d46b08',
  mismatch: '#a8071a',
};

/** 离散率 → 浅底色 */
export const DISCRETE_BG: Record<DiscreteLevel, string> = {
  normal: '#f6ffed',
  watch: '#fff7e6',
  mismatch: '#fff1f0',
};
