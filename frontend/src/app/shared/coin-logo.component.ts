import { Component, Input } from '@angular/core';

const LOGO_NAMES: Record<string, string> = {
  ADA: 'Cardano',
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'XRP'
};

@Component({
  selector: 'pd-coin-logo',
  standalone: true,
  template: '<img class="coinLogoImage" [src]="assetPath" [attr.alt]="decorative ? \'\' : accessibleName" [attr.aria-hidden]="decorative ? \'true\' : null" width="32" height="32" draggable="false">',
  styles: [':host{display:block;width:100%;height:100%;line-height:0}.coinLogoImage{display:block;width:100%;height:100%;object-fit:contain}']
})
export class CoinLogoComponent {
  @Input({ required: true }) symbol = '';
  @Input() label = '';
  @Input() decorative = false;

  get assetPath(): string {
    const ticker = this.symbol.toUpperCase().replace(/USD$/, '');
    return `/assets/coins/${ticker in LOGO_NAMES ? ticker.toLowerCase() : 'asset'}.svg`;
  }

  get accessibleName(): string {
    const ticker = this.symbol.toUpperCase().replace(/USD$/, '');
    return `${this.label || LOGO_NAMES[ticker] || ticker} logo`;
  }
}
