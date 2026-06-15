import type { ChartData, ChartOptions, ChartType } from "chart.js";
import { Chart as ReactChart } from "react-chartjs-2";
import { chartChrome } from "../../lib/charts";
import { useTheme } from "../../lib/theme";

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Deep-merge the theme chrome with each chart's own options so nested keys (scales.x.ticks, …)
// combine rather than clobber.
function deepMerge<T>(base: unknown, override: unknown): T {
  if (!isObj(base) || !isObj(override)) return (override ?? base) as T;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = isObj(base[k]) && isObj(override[k]) ? deepMerge(base[k], override[k]) : override[k];
  }
  return out as T;
}

interface Props<T extends ChartType> {
  type: T;
  data: ChartData<T>;
  options?: ChartOptions<T>;
  height?: number;
}

/** react-chartjs-2 wrapper that applies the current theme's chrome and a fixed-height container. */
export function ChartCanvas<T extends ChartType>({ type, data, options, height = 240 }: Props<T>) {
  const { theme } = useTheme();
  const merged = deepMerge<ChartOptions<T>>(chartChrome(theme), options ?? {});
  return (
    <div className="chart-box" style={{ height }}>
      <ReactChart type={type} data={data} options={merged} />
    </div>
  );
}
