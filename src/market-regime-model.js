const MIN_OBSERVATIONS = 18;
const CLUSTER_COUNT = 3;
const WINDOW_SIZE = 24;
const WINDOW_STEP = 4;

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function features(values) {
  const window = values.slice(-WINDOW_SIZE);
  if (window.length < Math.max(8, WINDOW_SIZE / 2)) return null;
  const momentum = window.slice(-8).reduce((sum, value) => sum + value, 0);
  const volatility = standardDeviation(window);
  const positiveRatio = window.filter((value) => value > 0).length / window.length;
  return [momentum, volatility, positiveRatio];
}

function distanceSquared(left, right) {
  return left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0);
}

function nearest(point, centroids) {
  let selected = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < centroids.length; index += 1) {
    const candidate = distanceSquared(point, centroids[index]);
    if (candidate < distance) {
      selected = index;
      distance = candidate;
    }
  }
  return { selected, distance };
}

function trainKMeans(observations) {
  const dimensions = observations[0].values.length;
  const means = Array.from({ length: dimensions }, (_, dimension) => average(observations.map((item) => item.values[dimension])));
  const scales = Array.from({ length: dimensions }, (_, dimension) => {
    const deviation = standardDeviation(observations.map((item) => item.values[dimension]));
    return deviation > 1e-9 ? deviation : 1;
  });
  const points = observations.map((item) => ({ ...item, scaled: item.values.map((value, index) => (value - means[index]) / scales[index]) }));

  const centroids = [points[0].scaled.slice()];
  while (centroids.length < CLUSTER_COUNT) {
    const candidate = points.reduce((best, point) => {
      const separation = Math.min(...centroids.map((centroid) => distanceSquared(point.scaled, centroid)));
      return separation > best.separation ? { point, separation } : best;
    }, { point: points[0], separation: -1 }).point;
    centroids.push(candidate.scaled.slice());
  }

  for (let iteration = 0; iteration < 8; iteration += 1) {
    const groups = centroids.map(() => []);
    for (const point of points) groups[nearest(point.scaled, centroids).selected].push(point.scaled);
    for (let group = 0; group < groups.length; group += 1) {
      if (!groups[group].length) continue;
      centroids[group] = Array.from({ length: dimensions }, (_, dimension) => average(groups[group].map((point) => point[dimension])));
    }
  }

  return { points, centroids, means, scales };
}

export class MarketRegimeModel {
  #enabled;
  #lastRunAt = 0;
  #lastSequence = -1;
  #lastResult = { status: "warming", algorithm: "K-means adaptativo", observations: 0, updatedAt: null, assets: [] };

  constructor(enabled = true) {
    this.#enabled = enabled;
  }

  infer(assets, sequence, now = Date.now()) {
    if (!this.#enabled) return { status: "disabled", algorithm: "Desativado", observations: 0, updatedAt: now, assets: assets.map((asset) => ({ symbol: asset.symbol, regime: "neutral", confidence: null, volatility: null })) };
    if (sequence === this.#lastSequence && now - this.#lastRunAt < 5000) return this.#lastResult;
    if (now - this.#lastRunAt < 5000 && this.#lastResult.status === "ready") return this.#lastResult;
    this.#lastSequence = sequence;
    this.#lastRunAt = now;

    const observations = [];
    for (const asset of assets) {
      for (let end = WINDOW_SIZE; end <= asset.returns.length; end += WINDOW_STEP) {
        const value = features(asset.returns.slice(0, end));
        if (value) observations.push({ symbol: asset.symbol, values: value });
      }
    }

    if (observations.length < MIN_OBSERVATIONS) {
      this.#lastResult = { status: "warming", algorithm: "K-means adaptativo", observations: observations.length, updatedAt: now, assets: assets.map((asset) => ({ symbol: asset.symbol, regime: "neutral", confidence: null, volatility: null })) };
      return this.#lastResult;
    }

    const model = trainKMeans(observations);
    const memberships = model.centroids.map(() => []);
    for (const point of model.points) memberships[nearest(point.scaled, model.centroids).selected].push(point.values);

    const clusterMetrics = memberships.map((group) => ({
      momentum: average(group.map((value) => value[0])),
      volatility: average(group.map((value) => value[1])),
      breadth: average(group.map((value) => value[2]))
    }));
    const medianVolatility = [...clusterMetrics].map((cluster) => cluster.volatility).sort((left, right) => left - right)[1] ?? 0;
    const latestBySymbol = new Map();
    for (const asset of assets) {
      const value = features(asset.returns);
      if (!value) continue;
      const scaled = value.map((item, index) => (item - model.means[index]) / model.scales[index]);
      const distances = model.centroids.map((centroid, index) => ({ index, distance: distanceSquared(scaled, centroid) })).sort((left, right) => left.distance - right.distance);
      const best = distances[0];
      const second = distances[1];
      const metrics = clusterMetrics[best.index];
      const regime = Math.abs(metrics.momentum) <= metrics.volatility * 0.2 ? "neutral" : metrics.momentum > 0 ? "bullish" : "bearish";
      const confidence = second.distance > 1e-8 ? Math.max(0, Math.min(1, (second.distance - best.distance) / second.distance)) : 0;
      latestBySymbol.set(asset.symbol, { symbol: asset.symbol, regime, confidence, volatility: metrics.volatility, cluster: best.index });
    }

    this.#lastResult = {
      status: "ready",
      algorithm: "K-means adaptativo",
      observations: observations.length,
      updatedAt: now,
      volatility: medianVolatility,
      assets: assets.map((asset) => latestBySymbol.get(asset.symbol) ?? { symbol: asset.symbol, regime: "neutral", confidence: null, volatility: null, cluster: null })
    };
    return this.#lastResult;
  }
}
