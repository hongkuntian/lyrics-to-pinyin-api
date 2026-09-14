"use client";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
export function SpendChart({
  data,
}: {
  data: { day: string; accounted: string }[];
}) {
  const chart = data.map((x) => ({
    day: x.day.slice(5),
    usd: Number(x.accounted) / 1000000,
  }));
  return (
    <div
      className="chart"
      role="img"
      aria-label="Accounted budget usage over the last seven UTC days"
    >
      <ResponsiveContainer
        width="100%"
        height={220}
        minWidth={0}
        initialDimension={{ width: 600, height: 220 }}
      >
        <BarChart
          data={chart}
          margin={{ top: 12, right: 4, left: 0, bottom: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis
            dataKey="day"
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            dy={8}
          />
          <YAxis
            width={48}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            tickFormatter={(v) => "$" + Number(v).toFixed(2)}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)" }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              color: "var(--foreground)",
            }}
            formatter={(v) => ["$" + Number(v).toFixed(6), "Budget usage"]}
          />
          <Bar
            dataKey="usd"
            fill="var(--primary)"
            radius={[4, 4, 0, 0]}
            maxBarSize={34}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
