/**
 * 离散率计算与判定
 * 离散率 = 标准差 / 均值 × 100%，衡量同一汇流箱内组串电流的一致性。
 * 纯函数，供采集页、排查工作台与处置单页共用。
 */
import { DEFAULT_THRESHOLDS, type ThresholdConfig } from '../types/settings';
import type {
  DiscreteLevel,
  IrradianceValue,
  Sample,
  StringDiscreteStat,
} from '../types/sample';
import { round } from './format';

/** 参与聚合的采集读数：携带补全后的辐照度与统计口径标记 */
export interface StatSample extends Sample {
  /** 实际用于归一化的辐照度（同箱中位数 / 上一条有效值补全） */
  effectiveIrradianceWm2: number;
  /** 是否计入统计（人工剔除或补全值过期时为 false） */
  countedInStats: boolean;
  /** 不计入统计的原因（剔除原因 / 补全过期） */
  uncountedReason: string | null;
}

/** 均值 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

/** 电流归一化修正：把实测电流折算到标准辐照度下，消除云影/时段影响 */
export function normalizeCurrent(
  currentA: number,
  irradianceWm2: IrradianceValue,
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): number {
  if (irradianceWm2 === null || irradianceWm2 <= 0) return round(currentA, 3);
  const ratio = config.standardIrradiance / irradianceWm2;
  // 辐照度极低时归一化会放大噪声，限制修正倍数上限为 2
  return round(currentA * Math.min(ratio, 2), 3);
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

/** 按时间序列计算某组串的离散率（逐点滚动均值法，取最后一个窗口作为当前离散率） */
export function rollingDiscreteRate(samples: Sample[], windowSize = 5): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  const window = sorted.slice(-Math.max(2, windowSize));
  return discreteRate(window.map((item) => normalizeCurrent(item.currentA, item.irradianceWm2)));
}

/** 分组键：同一逆变器 + 同一汇流箱视为一个可比对集合 */
export function groupKeyOf(row: { inverterId: string; combinerBox: string }): string {
  return `${row.inverterId}::${row.combinerBox}`;
}

/**
 * 由采集记录聚合出组串离散率榜。
 * 同一汇流箱内的组串电流互为基准，逐组串计算离散率与电流偏差。
 * 仅 countedInStats 的读数参与计算；无任何有效读数的组串退出统计（不出现在榜单中），
 * 原始记录仍保留在采集表内，可随时恢复。
 */
export function buildStringStats(
  samples: StatSample[],
  config: ThresholdConfig = DEFAULT_THRESHOLDS,
): StringDiscreteStat[] {
  const grouped = new Map<string, StatSample[]>();
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
    /** 参与统计的读数条数 */
    count: number;
    /** 原始记录总数（含剔除 / 过期） */
    totalCount: number;
    /** 人工剔除条数 */
    excludedCount: number;
    /** 补全辐照度过期而退出统计的条数 */
    staleCount: number;
  }

  const drafts: Draft[] = [];
  for (const [stringId, list] of grouped) {
    const sortedAll = [...list].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
    const counted = sortedAll.filter((item) => item.countedInStats);
    // 无一条读数可计入统计：整串退出榜单，避免错误来源误报失配
    if (counted.length === 0) continue;
    const window = counted.slice(-8);
    drafts.push({
      stringId,
      values: window.map((item) => normalizeCurrent(item.currentA, item.effectiveIrradianceWm2, config)),
      raws: window.map((item) => item.currentA),
      lastSampledAt: sortedAll[sortedAll.length - 1]?.sampledAt ?? '',
      count: counted.length,
      totalCount: sortedAll.length,
      excludedCount: sortedAll.filter((item) => item.excludedFromStats).length,
      staleCount: sortedAll.filter((item) => !item.countedInStats && !item.excludedFromStats).length,
    });
  }

  const stats: StringDiscreteStat[] = drafts.map((draft) => ({
    stringId: draft.stringId,
    stringCode: '',
    combinerBox: '',
    inverterId: '',
    arrayId: '',
    plantId: '',
    totalSampleCount: draft.totalCount,
    sampleCount: draft.count,
    excludedCount: draft.excludedCount,
    staleCount: draft.staleCount,
    avgCurrentA: round(mean(draft.raws), 2),
    avgNormalizedCurrentA: round(mean(draft.values), 3),
    discreteRate: discreteRate(draft.values),
    currentBiasPercent: 0,
    level: 'normal',
    lastSampledAt: draft.lastSampledAt,
  }));

  // 逐集合（汇流箱）计算相对偏差与最终档位（上下文由调用方补齐前按全局口径兜底）
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
