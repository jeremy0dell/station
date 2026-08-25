export type Distribution = {
  samples: number[];
  median: number;
  p90: number;
  p95: number;
  max: number;
};

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { samples: [], median: 0, p90: 0, p95: 0, max: 0 };
  }
  const samples = [...values].sort((left, right) => left - right);
  return {
    samples,
    median: percentile(samples, 0.5),
    p90: percentile(samples, 0.9),
    p95: percentile(samples, 0.95),
    max: samples.at(-1) ?? 0,
  };
}

export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}
