/**
 * Metrics — 可观测性指标
 * 暴露 Prometheus 格式的 /metrics 端点
 */

import 'reflect-metadata';
import { singleton } from 'tsyringe';

interface Counter { name: string; help: string; value: number; labels: Record<string, string>; }
interface Gauge { name: string; help: string; value: number; labels: Record<string, string>; }
interface Histogram { name: string; help: string; buckets: Record<string, number>; sum: number; count: number; }

@singleton()
export class Metrics {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  inc(name: string, help: string, value = 1, labels: Record<string, string> = {}): void {
    const key = `${name}${JSON.stringify(labels)}`;
    const existing = this.counters.get(key);
    if (existing) { existing.value += value; }
    else { this.counters.set(key, { name, help, value, labels }); }
  }

  set(name: string, help: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}${JSON.stringify(labels)}`;
    this.gauges.set(key, { name, help, value, labels });
  }

  observe(name: string, help: string, value: number, buckets: number[] = [10,50,100,500,1000]): void {
    const key = name;
    let h = this.histograms.get(key);
    if (!h) {
      h = { name, help, buckets: {}, sum: 0, count: 0 };
      for (const b of buckets) h.buckets[b] = 0;
      this.histograms.set(key, h);
    }
    h.sum += value; h.count += 1;
    for (const b of buckets) if (value <= b) h.buckets[b] = (h.buckets[b]||0) + 1;
  }

  serialize(): string {
    const lines: string[] = [];
    for (const c of this.counters.values()) {
      lines.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`, `${c.name}{${Object.entries(c.labels).map(([k,v])=>`${k}="${v}"`).join(',')}} ${c.value}`);
    }
    for (const g of this.gauges.values()) {
      lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name}{${Object.entries(g.labels).map(([k,v])=>`${k}="${v}"`).join(',')}} ${g.value}`);
    }
    for (const h of this.histograms.values()) {
      lines.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
      for (const [b,c] of Object.entries(h.buckets)) lines.push(`${h.name}_bucket{le="${b}"} ${c}`);
      lines.push(`${h.name}_sum ${h.sum}`, `${h.name}_count ${h.count}`);
    }
    return lines.join('\n') + '\n';
  }

  signalReceived(strategyId: string): void { this.inc('bbt_signals_total','Total signals received',1,{strategy_id:strategyId}); }
  signalDispatched(count: number): void { this.inc('bbt_signals_dispatched_total','Total signals dispatched',count); }
  setPeerCount(count: number): void { this.set('bbt_peers_online','Current online peers',count); }
  billingConfirmed(amount: number): void { this.inc('bbt_billing_confirmed_bbt_total','Total confirmed BBT billing',amount); }
}
