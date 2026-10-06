/**
 * 辐照度缺失补全与统计口径
 * 纯函数，供 sampleStore 在聚合离散率前统一补全：
 *   1. 优先取「同一次采集（同一采样时间）+ 同一汇流箱」其他组串实测辐照度的中位数；
 *   2. 整箱都缺时，沿用本组串「上一条实测有效值」；
 *   3. 沿用值距本次采集超过 FALLBACK_MAX_AGE_MIN 分钟（30 分钟）则退出统计，避免来源选错误报失配。
 * 被人工剔除（excludedFromStats）的读数始终保留、可查看，但不进入统计集合。
 */
import type {
  IrradianceSource,
  IrradianceValue,
  Sample,
} from '../types/sample';
import { isValidIrradiance } from '../types/sample';
import { mean } from './discrete';

/** 上一条有效值沿用的最长有效期（分钟），超时退出统计 */
export const FALLBACK_MAX_AGE_MIN = 30;

/** 补全所需的设备上下文：定位组串所属逆变器与汇流箱 */
export interface IrradianceOwner {
  stringId: string;
  inverterId: string;
  combinerBox: string;
}

export interface ResolvedIrradiance {
  /** 用于归一化计算的辐照度（无可用值时为 0，调用方应按 source === 'none' 处理） */
  effectiveIrradianceWm2: number;
  /** 取值来源 */
  source: IrradianceSource;
  /** 是否计入统计（人工剔除在外层另行判断；本字段仅反映辐照度过期问题） */
  fresh: boolean;
}

/** 数值中位数（偶数个取中间两数均值） */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? mean([sorted[mid - 1], sorted[mid]]) : sorted[mid];
}

/** 两个 yyyy-MM-dd HH:mm 时间相差的分钟数（b - a，无法解析时返回 NaN） */
export function diffMinutes(a: string, b: string): number {
  const parse = (text: string): number => {
    const t = text.replace(' ', 'T');
    return new Date(t).getTime();
  };
  const ta = parse(a);
  const tb = parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return NaN;
  return (tb - ta) / 60000;
}

/**
 * 批量补全辐照度。
 * @param samples 含缺失辐照度的采集读数（顺序任意，内部按时间排序）
 * @param owners  stringId → 所属逆变器/汇流箱
 */
export function resolveIrradianceBatch(
  samples: Sample[],
  owners: Map<string, IrradianceOwner>,
): Map<string, ResolvedIrradiance> {
  const result = new Map<string, ResolvedIrradiance>();

  // 1) 实测值直接采用
  for (const sample of samples) {
    if (isValidIrradiance(sample.irradianceWm2)) {
      result.set(sample.id, {
        effectiveIrradianceWm2: sample.irradianceWm2,
        source: 'measured',
        fresh: true,
      });
    }
  }

  // 2) 同一次采集（同一 sampledAt）+ 同一汇流箱的实测中位数
  //    key = inverterId::combinerBox::sampledAt → 实测辐照度列表
  const occasionBox = new Map<string, number[]>();
  for (const sample of samples) {
    if (!isValidIrradiance(sample.irradianceWm2)) continue;
    const owner = owners.get(sample.stringId);
    if (!owner) continue;
    const key = `${owner.inverterId}::${owner.combinerBox}::${sample.sampledAt}`;
    const list = occasionBox.get(key);
    if (list) list.push(sample.irradianceWm2);
    else occasionBox.set(key, [sample.irradianceWm2]);
  }

  // 3) 每个组串按时间排序的实测序列，用于「上一条有效值」沿用
  const measuredByString = new Map<string, Array<{ sampledAt: string; value: number }>>();
  for (const sample of samples) {
    if (!isValidIrradiance(sample.irradianceWm2)) continue;
    const list = measuredByString.get(sample.stringId);
    if (list) list.push({ sampledAt: sample.sampledAt, value: sample.irradianceWm2 });
    else measuredByString.set(sample.stringId, [{ sampledAt: sample.sampledAt, value: sample.irradianceWm2 }]);
  }
  for (const list of measuredByString.values()) {
    list.sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
  }

  const unresolved = samples.filter((sample) => !result.has(sample.id));
  for (const sample of unresolved) {
    const owner = owners.get(sample.stringId);

    // 3.1 同次同箱其他组串的实测中位数
    if (owner) {
      const peerValues = occasionBox
        .get(`${owner.inverterId}::${owner.combinerBox}::${sample.sampledAt}`)
        ?.filter((value) => Number.isFinite(value));
      const peerMedian = peerValues && peerValues.length > 0 ? median(peerValues) : 0;
      if (peerMedian > 0) {
        result.set(sample.id, {
          effectiveIrradianceWm2: peerMedian,
          source: 'peerMedian',
          fresh: true,
        });
        continue;
      }
    }

    // 3.2 整箱都缺：沿用本组串上一条实测有效值（必须早于本次采集）
    const history = measuredByString.get(sample.stringId) ?? [];
    let previous: { sampledAt: string; value: number } | null = null;
    for (const item of history) {
      if (item.sampledAt < sample.sampledAt) previous = item;
      else break;
    }
    if (previous) {
      const gap = diffMinutes(previous.sampledAt, sample.sampledAt);
      // 超过 30 分钟：补全值过期，读数保留但退出统计
      const fresh = Number.isNaN(gap) || gap <= FALLBACK_MAX_AGE_MIN;
      result.set(sample.id, {
        effectiveIrradianceWm2: previous.value,
        source: 'previous',
        fresh,
      });
      continue;
    }

    // 3.3 无任何可用来源
    result.set(sample.id, { effectiveIrradianceWm2: 0, source: 'none', fresh: false });
  }

  return result;
}

/** 单条补全的便捷封装（依赖调用方提供全量读数） */
export function resolveIrradiance(
  target: Sample,
  samples: Sample[],
  owners: Map<string, IrradianceOwner>,
): ResolvedIrradiance {
  return resolveIrradianceBatch(samples, owners).get(target.id) ?? {
    effectiveIrradianceWm2: 0,
    source: 'none' as IrradianceSource,
    fresh: false,
  };
}

/** 表单/导入值归一化：空值与非正数统一落 null 表示缺失 */
export function normalizeIrradianceInput(value: IrradianceValue | undefined | ''): IrradianceValue {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}
