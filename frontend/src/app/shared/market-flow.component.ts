import { AfterViewInit, Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, signal } from '@angular/core';
import { MarketIntelligence, NetworkNode } from '../core/market.types';
import { money, shortTime, signedPercent } from '../core/format';

interface NodePosition extends NetworkNode {
  canvasX: number;
  canvasY: number;
}

interface FaceParticle {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
  sourceIndex: number;
  feature: number;
}

interface ProjectedParticle extends FaceParticle {
  screenX: number;
  screenY: number;
  depth: number;
  perspective: number;
}

@Component({
  selector: 'pd-market-flow',
  standalone: true,
  templateUrl: './market-flow.component.html',
  styles: [':host{display:contents}']
})
export class MarketFlowComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('aiFaceCanvas') private faceCanvas?: ElementRef<HTMLCanvasElement>;
  @Input() nodes: NetworkNode[] = [];
  @Input() intelligence: MarketIntelligence | null = null;
  @Input() feedFresh = false;
  @Input() updatedAt: number | null = null;
  @Input() selectedSymbol = '';
  @Output() symbolSelected = new EventEmitter<string>();

  readonly math = Math;
  readonly money = money;
  readonly shortTime = shortTime;
  readonly signedPercent = signedPercent;
  readonly sequenceIndex = signal(0);
  private readonly faceParticles = this.createFaceParticles(220);
  private readonly projectedParticles: ProjectedParticle[] = this.faceParticles.map((particle) => ({
    ...particle,
    screenX: 0,
    screenY: 0,
    depth: 0,
    perspective: 1
  }));
  private readonly reducedMotionQuery = typeof window === 'undefined' ? null : window.matchMedia('(prefers-reduced-motion: reduce)');
  private context: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private animationFrame = 0;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;
  private rotationStart = 0;
  private lastFrameAt = 0;
  private lastSequenceIndex = -1;
  private nodeOrigins: Array<{ x: number; y: number }> = [];
  private isReducedMotion = false;
  private isInViewport = true;
  private readonly frameInterval = 1000 / 24;

  constructor(private readonly ngZone: NgZone) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['nodes']) this.updateNodeOrigins();
  }

  private readonly visibilityHandler = (): void => {
    this.updateAnimationState();
  };

  private readonly intersectionHandler = (entries: IntersectionObserverEntry[]): void => {
    this.isInViewport = entries[0]?.isIntersecting ?? true;
    this.updateAnimationState();
  };

  private readonly motionPreferenceHandler = (event: MediaQueryListEvent): void => {
    this.isReducedMotion = event.matches;
    cancelAnimationFrame(this.animationFrame);
    this.rotationStart = performance.now();
    this.lastFrameAt = 0;
    this.drawFrame(this.rotationStart);
  };

  ngAfterViewInit(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined' || typeof ResizeObserver === 'undefined') return;
    const canvas = this.faceCanvas?.nativeElement;
    if (!canvas) return;

    this.ngZone.runOutsideAngular(() => {
      this.context = canvas.getContext('2d', { alpha: true });
      if (!this.context) return;

      this.isReducedMotion = this.reducedMotionQuery?.matches ?? false;
      this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
      this.resizeObserver.observe(canvas);
      this.intersectionObserver = new IntersectionObserver(this.intersectionHandler, { threshold: 0.01 });
      this.intersectionObserver.observe(canvas);
      document.addEventListener('visibilitychange', this.visibilityHandler);
      this.reducedMotionQuery?.addEventListener('change', this.motionPreferenceHandler);
      this.updateNodeOrigins();
      this.resizeCanvas();
      this.rotationStart = performance.now();
      this.drawFrame(this.rotationStart);
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.reducedMotionQuery?.removeEventListener('change', this.motionPreferenceHandler);
  }

  get positionedNodes(): NodePosition[] {
    return this.nodes.map((node) => ({
      ...node,
      canvasX: 42 + node.x * 516,
      canvasY: 30 + node.y * 250
    }));
  }

  get sequenceLabel(): string {
    return this.nodes[this.sequenceIndex()]?.label ?? 'ATIVOS';
  }

  get intelligenceLabel(): string {
    if (!this.feedFresh) return 'MODELO PAUSADO · SEM COTAÇÃO ATUAL';
    if (this.intelligence?.status === 'disabled') return 'MODELO LOCAL DESATIVADO';
    if (this.intelligence?.status !== 'ready') return 'IA LOCAL · CALIBRANDO COM DADOS AO VIVO';
    return `IA LOCAL · ${this.intelligence.observations} AMOSTRAS · ${this.intelligence.updatedAt ? this.shortTime(this.intelligence.updatedAt) + ' BRT' : 'INFERÊNCIA ATIVA'}`;
  }

  regimeLabel(regime: NetworkNode['regime']): string {
    return regime === 'bullish' ? 'MOMENTUM +' : regime === 'bearish' ? 'MOMENTUM −' : 'LATERAL';
  }

  coinLogoPath(symbol: string): string {
    const ticker = symbol.toUpperCase().replace(/USD$/, '');
    return `/assets/coins/${['BTC', 'ETH', 'SOL', 'XRP', 'ADA'].includes(ticker) ? ticker.toLowerCase() : 'asset'}.svg`;
  }

  private resizeCanvas(): void {
    const canvas = this.faceCanvas?.nativeElement;
    if (!canvas || !this.context) return;

    const bounds = canvas.getBoundingClientRect();
    this.width = bounds.width;
    this.height = bounds.height;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1);
    canvas.width = Math.round(this.width * this.pixelRatio);
    canvas.height = Math.round(this.height * this.pixelRatio);
    this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    this.updateNodeOrigins();
    this.drawFrame(performance.now());
  }

  private updateNodeOrigins(): void {
    const canvas = this.faceCanvas?.nativeElement;
    const svg = canvas?.parentElement?.querySelector<SVGSVGElement>('.flowSvg');
    const matrix = svg?.getScreenCTM();
    if (!canvas || !svg || !matrix) return;
    const bounds = canvas.getBoundingClientRect();
    this.nodeOrigins = this.nodes.map((node) => {
      const point = svg.createSVGPoint();
      point.x = 42 + node.x * 516;
      point.y = 30 + node.y * 250;
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x - bounds.left, y: screenPoint.y - bounds.top };
    });
  }

  private drawFrame(timestamp: number): void {
    const context = this.context;
    if (!context || !this.width || !this.height) return;
    if (!this.isInViewport || document.hidden) return;

    if (!this.isReducedMotion && timestamp - this.lastFrameAt < this.frameInterval) {
      this.animationFrame = requestAnimationFrame((nextTimestamp) => this.drawFrame(nextTimestamp));
      return;
    }
    this.lastFrameAt = timestamp;

    context.clearRect(0, 0, this.width, this.height);
    const elapsed = this.isReducedMotion ? 0 : Math.max(0, timestamp - this.rotationStart);
    const sequenceDuration = 3200;
    const activeIndex = this.nodes.length ? Math.floor(elapsed / sequenceDuration) % this.nodes.length : 0;
    this.setSequenceIndex(activeIndex);
    const angle = elapsed * Math.PI * 2 / 48;
    const pitch = Math.sin(elapsed / 17000) * 0.045;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const pitchCosine = Math.cos(pitch);
    const pitchSine = Math.sin(pitch);
    const scale = Math.min(this.width * 0.08, this.height * 0.18);
    const centerX = this.width / 2;
    const centerY = this.height * 0.54;
    for (let index = 0; index < this.faceParticles.length; index += 1) {
      const particle = this.faceParticles[index];
      const rotatedX = particle.x * cosine + particle.z * sine;
      const rotatedZ = -particle.x * sine + particle.z * cosine;
      const rotatedY = particle.y * pitchCosine - rotatedZ * pitchSine;
      const depth = rotatedY * pitchSine + rotatedZ * pitchCosine;
      const perspective = 3.2 / (3.2 - depth * 0.52);
      const projected = this.projectedParticles[index];
      projected.screenX = centerX + rotatedX * scale * perspective;
      projected.screenY = centerY + rotatedY * scale * perspective;
      projected.depth = depth;
      projected.perspective = perspective;
    }

    this.projectedParticles.sort((first, second) => first.depth - second.depth);
    let particleIndex = 0;
    for (const particle of this.projectedParticles) {
      const visibility = Math.max(0.2, Math.min(1, 0.57 + particle.depth * 0.49));
      const shimmer = this.isReducedMotion || particleIndex % 7 !== 0 ? 1 : 0.94 + Math.sin(elapsed / 900 + particle.phase) * 0.06;
      const radius = particle.size * particle.perspective * (particle.feature ? 1.18 : 1);
      context.globalAlpha = visibility * shimmer * (this.feedFresh ? 0.9 : 0.58);
      context.fillStyle = this.particleColor(particle);
      context.shadowColor = 'transparent';
      context.shadowBlur = 0;
      context.beginPath();
      context.arc(particle.screenX, particle.screenY, radius, 0, Math.PI * 2);
      context.fill();
      particleIndex += 1;
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
    this.drawCoinTransfer(context, activeIndex, (elapsed % sequenceDuration) / sequenceDuration, centerX, centerY, scale);

    if (!this.isReducedMotion && !document.hidden) {
      this.animationFrame = requestAnimationFrame((nextTimestamp) => this.drawFrame(nextTimestamp));
    }
  }

  private setSequenceIndex(index: number): void {
    if (index === this.lastSequenceIndex) return;
    this.lastSequenceIndex = index;
    this.ngZone.run(() => this.sequenceIndex.set(index));
  }

  private drawCoinTransfer(context: CanvasRenderingContext2D, index: number, phase: number, centerX: number, centerY: number, scale: number): void {
    const origin = this.nodeOrigins[index];
    const market = this.nodes[index];
    if (!origin || !market) return;

    const transferProgress = (phase - 0.1) / 0.72;
    if (transferProgress < 0 || transferProgress > 1.72) return;
    const targetX = centerX;
    const targetY = centerY;
    const controlX = (origin.x + targetX) / 2 + (origin.y - targetY) * 0.12;
    const controlY = (origin.y + targetY) / 2 + (targetX - origin.x) * 0.08;
    const color = this.regimeColor(market.regime);

    for (let particle = 0; particle < 6; particle += 1) {
      const progress = transferProgress - particle * 0.13;
      if (progress < 0 || progress > 1) continue;
      const inverse = 1 - progress;
      const eased = progress * progress * (3 - 2 * progress);
      const x = inverse * inverse * origin.x + 2 * inverse * eased * controlX + eased * eased * targetX;
      const y = inverse * inverse * origin.y + 2 * inverse * eased * controlY + eased * eased * targetY;
      const radius = (1.2 - progress * 0.45) * (particle === 0 ? 1.25 : 1);
      context.globalAlpha = Math.sin(Math.PI * progress) * 0.9;
      context.fillStyle = color;
      context.shadowColor = color;
      context.shadowBlur = particle === 0 ? 4 : 2;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    context.shadowBlur = 0;
  }

  private updateAnimationState(): void {
    cancelAnimationFrame(this.animationFrame);
    if (document.hidden || !this.isInViewport) return;
    this.rotationStart = performance.now();
    this.lastFrameAt = 0;
    this.drawFrame(this.rotationStart);
  }

  private particleColor(particle: FaceParticle): string {
    const node = this.nodes[particle.sourceIndex % Math.max(this.nodes.length, 1)];
    if (!this.feedFresh || !node || !Number.isFinite(node.change)) {
      return particle.feature ? '#d8c7e6' : particle.sourceIndex % 3 === 0 ? '#bca8cf' : '#9babb0';
    }
    return particle.feature ? this.regimeColor(node.regime) : this.mixColor(this.regimeColor(node.regime), '#b9c7c4', 0.34);
  }

  private regimeColor(regime: NetworkNode['regime']): string {
    if (regime === 'bullish') return '#75e2b4';
    if (regime === 'bearish') return '#d58ab9';
    return '#dfc57d';
  }

  private mixColor(color: string, background: string, amount: number): string {
    const channels = (value: string) => value.match(/[a-f\d]{2}/gi)?.map((part) => Number.parseInt(part, 16)) ?? [0, 0, 0];
    const foreground = channels(color);
    const base = channels(background);
    return `rgb(${foreground.map((channel, index) => Math.round(channel * amount + base[index] * (1 - amount))).join(' ')})`;
  }

  private createFaceParticles(count: number): FaceParticle[] {
    let seed = 91273;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };

    return Array.from({ length: count }, (_, index) => {
      const vertical = random() * 1.9 - 0.95;
      const latitudeRadius = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      const jawTaper = vertical < -0.06 ? 0.7 + ((vertical + 0.95) / 0.89) * 0.3 : 1 - Math.max(0, vertical) * 0.08;
      const longitude = random() * Math.PI * 2;
      const front = Math.max(0, Math.cos(longitude));
      const x = Math.sin(longitude) * latitudeRadius * 0.73 * jawTaper;
      const y = vertical;
      let z = Math.cos(longitude) * latitudeRadius * 0.52;

      if (front > 0) {
        z += this.gaussian(x, y, 0, 0.03, 0.075, 0.24) * front;
        z -= (this.gaussian(x, y, -0.23, -0.15, 0.09, 0.045) + this.gaussian(x, y, 0.23, -0.15, 0.09, 0.045)) * front;
        z += (this.gaussian(x, y, -0.2, -0.22, 0.14, 0.04) + this.gaussian(x, y, 0.2, -0.22, 0.14, 0.04)) * front * 0.08;
        z += (this.gaussian(x, y, -0.36, 0.03, 0.13, 0.11) + this.gaussian(x, y, 0.36, 0.03, 0.13, 0.11)) * front * 0.09;
        z += this.gaussian(x, y, 0, 0.33, 0.16, 0.035) * front * 0.06;
      }

      const leftEye = Math.hypot(x + 0.23, (y + 0.15) * 1.35);
      const rightEye = Math.hypot(x - 0.23, (y + 0.15) * 1.35);
      const eyeDetail = front > 0.45 && Math.min(leftEye, rightEye) < 0.085 ? 1 : 0;
      const noseDetail = front > 0.6 && Math.abs(x) < 0.065 && y > -0.08 && y < 0.18 ? 1 : 0;
      const mouthDetail = front > 0.55 && Math.abs(y - (0.33 + Math.abs(x) * 0.12)) < 0.035 && Math.abs(x) < 0.2 ? 1 : 0;

      return {
        x,
        y,
        z,
        size: 0.36 + random() * 0.58 + ((eyeDetail + noseDetail + mouthDetail) ? 0.2 : 0),
        phase: random() * Math.PI * 2,
        sourceIndex: index % 5,
        feature: eyeDetail || noseDetail || mouthDetail
      };
    });
  }

  private gaussian(x: number, y: number, centerX: number, centerY: number, radiusX: number, radiusY: number): number {
    const normalizedX = (x - centerX) / radiusX;
    const normalizedY = (y - centerY) / radiusY;
    return Math.exp(-0.5 * (normalizedX * normalizedX + normalizedY * normalizedY));
  }
}
