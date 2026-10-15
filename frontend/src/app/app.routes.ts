import { Routes } from '@angular/router';
import { ActivityPageComponent } from './pages/activity/activity-page.component';
import { PortfolioPageComponent } from './pages/portfolio/portfolio-page.component';
import { TerminalPageComponent } from './pages/terminal/terminal-page.component';

export const routes: Routes = [
  { path: '', pathMatch: 'full', component: TerminalPageComponent, title: 'Terminal | Pulse Desk' },
  { path: 'portfolio', component: PortfolioPageComponent, title: 'Portfólio | Pulse Desk' },
  { path: 'activity', component: ActivityPageComponent, title: 'Atividade | Pulse Desk' },
  { path: '**', redirectTo: '' }
];
