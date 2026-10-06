import type { Revisioned } from './persistence';

/** 辐照度来源：实测 / 同次同汇流箱中位数 / 沿用上一条有效值 / 缺测退出统计 */
export type IrradianceSource = 'measured' | 'boxMedian' | 'carried' | 'missing';

export const IRRADIANCE_SOURCE_LABEL: Record<IrradianceSource, string> = {
  measured: '实测',
  boxMedian: '同箱中位',
  carried: '沿用上次',
  missing: '缺测退出',
};

/** 组串采集读数 */
export interface Sample {
  id: string;
  /** 所属组串 */
  stringId: string;
  /** 采集时间 yyyy-MM-dd HH:mm */
  sampledAt: string;
  /** 电流（A） */
  currentA: number;
  /** 电压（V） */
  voltageV: number;
  /** 辐照度原始读数（W/m²），缺测为 null（原始记录保留，不参与归一化） */
  irradianceWm2: number | null;
  /** 辐照度来源（归一化口径，来源选错会误报失配，故落库可追溯） */
  irradianceSource: IrradianceSource;
  /** 用于归一化的有效辐照度（W/m²）：实测值 / 同箱中位数 / 沿用值；缺测退出为 null */
  effectiveIrradianceWm2: number | null;
  /** 复核开关：true 表示受云影等影响不计入统计（原始记录保留可查看，可重新计入恢复） */
  excludedFromStats: boolean;
  /** 离散率（%），由 utils/discrete.ts 计算后落库 */
  discreteRate: number;
  createdAt: string;
}

/** 该条读数是否计入离散率统计：人工未剔除且辐照度未缺测退出 */
export function isSampleCountable(sample: Pick<Sample, 'excludedFromStats' | 'irradianceSource'>): boolean {
  return !sample.excludedFromStats && sample.irradianceSource !== 'missing';
}

/** 录入采集读数的表单草稿（离散率与辐照度来源由系统计算） */
export interface SampleDraft {
  stringId: string;
  sampledAt: string;
  currentA: number;
  voltageV: number;
  /** 辐照度可留空，系统按同箱中位数 / 沿用上一条有效值补齐 */
  irradianceWm2: number | null;
}

/** 离散率档位 */
export type DiscreteLevel = 'normal' | 'watch' | 'mismatch';

export const DISCRETE_LEVEL_LABEL: Record<DiscreteLevel, string> = {
  normal: '正常',
  watch: '关注',
  mismatch: '失配',
};

/** 采集行数据（带组串与设备上下文） */
export interface SampleRow extends Sample, Revisioned {
  stringCode: string;
  combinerBox: string;
  inverterId: string;
  inverterModel: string;
  arrayId: string;
  arrayCode: string;
  plantId: string;
  plantName: string;
  /** 辐照度归一化后的电流（折算到 1000 W/m²） */
  normalizedCurrentA: number;
}

/** 按组串聚合的统计结果，用于离散率榜 */
export interface StringDiscreteStat {
  stringId: string;
  stringCode: string;
  combinerBox: string;
  inverterId: string;
  arrayId: string;
  plantId: string;
  /** 计入统计的采集点数（已剔除与缺测退出的不计） */
  sampleCount: number;
  /** 被人工剔除（不计入统计）的读数条数 */
  excludedCount: number;
  avgCurrentA: number;
  avgNormalizedCurrentA: number;
  discreteRate: number;
  /** 相对同汇流箱均值的偏差百分比 */
  currentBiasPercent: number;
  level: DiscreteLevel;
  lastSampledAt: string;
}

/** 采集时间排序辅助 */
export function compareBySampledAt(a: Sample, b: Sample): number {
  return a.sampledAt.localeCompare(b.sampledAt);
}
