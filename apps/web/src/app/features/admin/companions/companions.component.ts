import { HttpClient } from '@angular/common/http';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../../environments/environment';

type CompanionStatus = 'ACTIVE' | 'INACTIVE';
type MemoryScope = 'PRIVATE' | 'SHARED';
type MemoryStatus = 'DRAFT' | 'APPROVED' | 'ARCHIVED';

interface Companion {
  id: string;
  slug: string;
  name: string;
  role_key: string;
  description: string | null;
  system_prompt: string | null;
  capabilities: string[];
  allowed_roles: string[];
  status: CompanionStatus;
  memory_count: number;
}

interface Memory {
  id: string;
  companion_id: string | null;
  scope: MemoryScope;
  status: MemoryStatus;
  title: string;
  content: string;
  owner_user_id: string | null;
  created_at: string;
}

@Component({
  selector: 'app-admin-companions',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './companions.component.html',
  styleUrl: './companions.component.scss',
})
export class CompanionsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly apiBase = environment.apiBase;
  readonly companions = signal<Companion[]>([]);
  readonly memories = signal<Memory[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  newCompanion = {
    slug: '',
    name: '',
    role_key: 'GENERAL',
    description: '',
    system_prompt: '',
    capabilities: 'text',
    allowed_roles: 'STUDENT, MENTOR, DIRECTOR, ADMIN',
  };
  newMemory = { title: '', content: '' };

  async ngOnInit(): Promise<void> {
    await this.loadCompanions();
  }

  async loadCompanions(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const rows = await firstValueFrom(
        this.http.get<Companion[]>(`${this.apiBase}/companions`, { withCredentials: true }),
      );
      this.companions.set(rows);
      if (!this.selectedId() && rows.length) this.selectedId.set(rows[0].id);
      if (this.selectedId()) await this.loadMemories(this.selectedId()!);
    } catch {
      this.error.set('Could not load the companion registry.');
    } finally {
      this.loading.set(false);
    }
  }

  selectedCompanion(): Companion | undefined {
    return this.companions().find((companion) => companion.id === this.selectedId());
  }

  async selectCompanion(id: string): Promise<void> {
    this.selectedId.set(id);
    await this.loadMemories(id);
  }

  async loadMemories(id: string): Promise<void> {
    try {
      const rows = await firstValueFrom(
        this.http.get<Memory[]>(`${this.apiBase}/companions/${encodeURIComponent(id)}/memory`, {
          withCredentials: true,
        }),
      );
      this.memories.set(rows);
    } catch {
      this.error.set('Could not load scoped memory for this companion.');
    }
  }

  async createCompanion(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const body = {
        ...this.newCompanion,
        capabilities: this.newCompanion.capabilities
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        allowed_roles: this.newCompanion.allowed_roles
          .split(',')
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
      };
      const created = await firstValueFrom(
        this.http.post<Companion>(`${this.apiBase}/companions`, body, { withCredentials: true }),
      );
      this.newCompanion = {
        slug: '',
        name: '',
        role_key: 'GENERAL',
        description: '',
        system_prompt: '',
        capabilities: 'text',
        allowed_roles: 'STUDENT, MENTOR, DIRECTOR, ADMIN',
      };
      this.selectedId.set(created.id);
      this.notice.set(`${created.name} was created.`);
      await this.loadCompanions();
    } catch {
      this.error.set('Could not create the companion. Check that the slug is unique.');
    } finally {
      this.saving.set(false);
    }
  }

  async createSharedMemory(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      await firstValueFrom(
        this.http.post<Memory>(`${this.apiBase}/companions/shared-memory`, this.newMemory, {
          withCredentials: true,
        }),
      );
      this.newMemory = { title: '', content: '' };
      this.notice.set('Shared memory saved as a draft. Approve it before companions can use it.');
      if (this.selectedId()) await this.loadMemories(this.selectedId()!);
    } catch {
      this.error.set('Could not save shared memory.');
    } finally {
      this.saving.set(false);
    }
  }

  async approve(memory: Memory): Promise<void> {
    const companionId = this.selectedId();
    if (!companionId) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.post(
          `${this.apiBase}/companions/${encodeURIComponent(companionId)}/memory/${encodeURIComponent(memory.id)}/approve`,
          {},
          { withCredentials: true },
        ),
      );
      this.notice.set('Shared memory approved and added to companion context.');
      await this.loadMemories(companionId);
    } catch {
      this.error.set('Could not approve this memory.');
    } finally {
      this.saving.set(false);
    }
  }

  async toggleStatus(companion: Companion): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.patch(
          `${this.apiBase}/companions/${encodeURIComponent(companion.id)}`,
          { status: companion.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' },
          { withCredentials: true },
        ),
      );
      await this.loadCompanions();
    } catch {
      this.error.set('Could not update companion status.');
    } finally {
      this.saving.set(false);
    }
  }
}
