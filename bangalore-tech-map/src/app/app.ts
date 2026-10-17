import { Component, computed, inject, viewChild } from '@angular/core';
import { DatasetService } from './core/dataset.service';
import { MapStateService } from './core/map-state.service';
import { MapComponent } from './map/map.component';
import { AboutDialogComponent } from './panels/about-dialog.component';
import { CompanyDetailComponent } from './panels/company-detail.component';
import { CompanyListComponent } from './panels/company-list.component';
import { FilterPanelComponent } from './panels/filter-panel.component';
import { LegendComponent } from './panels/legend.component';
import { ParkDetailComponent } from './panels/park-detail.component';

@Component({
  selector: 'app-root',
  imports: [MapComponent, FilterPanelComponent, CompanyListComponent, CompanyDetailComponent, ParkDetailComponent, LegendComponent, AboutDialogComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  host: { '[class.has-detail]': 'hasDetail()', '[class.sidebar-closed]': '!state.sidebarOpen()' },
})
export class App {
  readonly ds = inject(DatasetService);
  readonly state = inject(MapStateService);
  private readonly about = viewChild.required(AboutDialogComponent);

  readonly hasDetail = computed(() => !!this.state.selectedCompany() || !!this.state.selectedPark());

  openAbout(): void {
    this.about().open();
  }

  toggleSidebar(): void {
    this.state.sidebarOpen.update((v) => !v);
  }
}
