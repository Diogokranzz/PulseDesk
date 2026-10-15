import { MarketIntelligence, NetworkNode } from './market.types';

const minimumObservations = 18;
const windowSize = 24;
const windowStep = 4;

type Regime = NetworkNode['regime'];
type Feature = [number, number, number];
type Observation = { symbol: string; values: Feature; scaled?: Feature };

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values: number[]): number {
  const mean = average(values);
  return values.length > 1 ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : 0;
}

function extractFeatures(values: number[]): Feature | null {
  const sample = values.slice(-windowSize);
  if (sample.length < 12) return null;
  return [sample.slice(-8).reduce((sum, value) => sum + value, 0), deviation(sample), sample.filter((value) => value > 0).length / sample.length];
}

function distance(left: Feature, right: Feature): number {
  return left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0);
}

export class MarketRegimeModel {
  private lastRunAt = 0;
  private lastSequence = -1;
  private lastResult: MarketIntelligence = { status: 'warming', algorithm: 'K-means adaptativo local', observations: 0, updatedAt: null, assets: [] };

  infer(returns: Array<{ symbol: string; values: number[] }>, sequence: number, now = Date.now()): MarketIntelligence {
    if (sequence === this.lastSequence && now - this.lastRunAt < 5000) return this.lastResult;
    if (now - this.lastRunAt < 5000 && this.lastResult.status === 'ready') return this.lastResult;
    this.lastSequence = sequence;
    this.lastRunAt = now;

    const observations: Observation[] = [];
    for (const asset of returns) {
      for (let end = windowSize; end <= asset.values.length; end += windowStep) {
        const values = extractFeatures(asset.values.slice(0, end));
        if (values) observations.push({ symbol: asset.symbol, values });
      }
    }
    if (observations.length < minimumObservations) {
      this.lastResult = { status: 'warming', algorithm: 'K-means adaptativo local', observations: observations.length, updatedAt: now, assets: returns.map(({ symbol }) => ({ symbol, regime: 'neutral', confidence: null, volatility: null })) };
      return this.lastResult;
    }

    const means = [0, 1, 2].map((dimension) => average(observations.map((item) => item.values[dimension])));
    const scales = [0, 1, 2].map((dimension) => Math.max(deviation(observations.map((item) => item.values[dimension])), 1e-9));
    const points = observations.map((item) => ({ ...item, scaled: item.values.map((value, index) => (value - means[index]) / scales[index]) as Feature }));
    const centroids: Feature[] = [points[0].scaled!];
    while (centroids.length < 3) {
      let best = points[0];
      let separation = -1;
      for (const point of points) {
        const closest = Math.min(...centroids.map((centroid) => distance(point.scaled!, centroid)));
        if (closest > separation) { best = point; separation = closest; }
      }
      centroids.push([...best.scaled!] as Feature);
    }

    const groups: Feature[][] = [];
    for (let iteration = 0; iteration < 8; iteration += 1) {
      groups.splice(0, groups.length, ...centroids.map(() => [] as Feature[]));
      for (const point of points) {
        let selected = 0;
        for (let index = 1; index < centroids.length; index += 1) if (distance(point.scaled!, centroids[index]) < distance(point.scaled!, centroids[selected])) selected = index;
        groups[selected].push(point.scaled!);
      }
      groups.forEach((group, index) => {
        if (group.length) centroids[index] = [0, 1, 2].map((dimension) => average(group.map((point) => point[dimension]))) as Feature;
      });
    }

    const clusterMetrics = centroids.map((_, index) => {
      const members = points.filter((point) => {
        let nearest = 0;
        for (let candidate = 1; candidate < centroids.length; candidate += 1) if (distance(point.scaled!, centroids[candidate]) < distance(point.scaled!, centroids[nearest])) nearest = candidate;
        return nearest === index;
      });
      return { momentum: average(members.map((point) => point.values[0])), volatility: average(members.map((point) => point.values[1])) };
    });

    const latestBySymbol = new Map<string, MarketIntelligence['assets'][number]>();
    for (const asset of returns) {
      const values = extractFeatures(asset.values);
      if (!values) continue;
      const scaled = values.map((value, index) => (value - means[index]) / scales[index]) as Feature;
      const ranked = centroids.map((centroid, index) => ({ index, distance: distance(scaled, centroid) })).sort((left, right) => left.distance - right.distance);
      const best = ranked[0];
      const second = ranked[1];
      const metrics = clusterMetrics[best.index];
      const regime: Regime = Math.abs(metrics.momentum) <= metrics.volatility * 0.2 ? 'neutral' : metrics.momentum > 0 ? 'bullish' : 'bearish';
      const confidence = second.distance > 1e-8 ? Math.max(0, Math.min(1, (second.distance - best.distance) / second.distance)) : 0;
      latestBySymbol.set(asset.symbol, { symbol: asset.symbol, regime, confidence, volatility: metrics.volatility, cluster: best.index });
    }
    this.lastResult = {
      status: 'ready', algorithm: 'K-means adaptativo local', observations: observations.length, updatedAt: now,
      assets: returns.map(({ symbol }) => latestBySymbol.get(symbol) ?? { symbol, regime: 'neutral', confidence: null, volatility: null, cluster: null })
    };
    return this.lastResult;
  }
}
