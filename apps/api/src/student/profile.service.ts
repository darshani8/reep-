/**
 * The student profile, server-side. Ports the reads and the writes from
 * src/app/student/profile/actions.ts.
 *
 * The leaderboard opt-out and the weekly target stay separate writes on purpose,
 * exactly as the React actions kept them: folding opt-out into the main save
 * would let a save about a phone number quietly put an opted-out student back on
 * every board. Blank strings are stored as null so "not supplied" is one value.
 */

import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export interface ProfileView {
  phone: string | null;
  email: string | null;
  linkedinUrl: string | null;
  githubUrl: string | null;
  portfolioUrl: string | null;
  city: string | null;
  careerSummary: string | null;
  skills: string[];
  leaderboardOptOut: boolean;
  weeklyHourTarget: number;
}

interface ContactDto {
  phone?: string;
  email?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  city?: string;
  careerSummary?: string;
}

const nullable = (v?: string): string | null => {
  const t = (v ?? '').trim();
  return t.length > 0 ? t : null;
};

/// Students paste "linkedin.com/in/…" more often than a full URL; a resume with
/// a dead link is worse than one with none — so a bare host gets https://.
const asUrl = (v?: string): string | null => {
  const t = nullable(v);
  if (!t) return null;
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
};

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(studentId: string): Promise<ProfileView> {
    const [profile, student] = await Promise.all([
      this.prisma.studentProfile.findUnique({ where: { studentId } }),
      this.prisma.student.findUnique({
        where: { id: studentId },
        select: { weeklyHourTarget: true },
      }),
    ]);

    const skills = Array.isArray(profile?.skills)
      ? (profile!.skills as { name?: string }[])
          .map((s) => (typeof s === 'string' ? s : s?.name))
          .filter((s): s is string => Boolean(s))
      : [];

    return {
      phone: profile?.phone ?? null,
      email: profile?.email ?? null,
      linkedinUrl: profile?.linkedinUrl ?? null,
      githubUrl: profile?.githubUrl ?? null,
      portfolioUrl: profile?.portfolioUrl ?? null,
      city: profile?.city ?? null,
      careerSummary: profile?.careerSummary ?? null,
      skills,
      leaderboardOptOut: profile?.leaderboardOptOut ?? false,
      weeklyHourTarget: student?.weeklyHourTarget ?? 12,
    };
  }

  async saveContact(studentId: string, dto: ContactDto): Promise<{ ok: true }> {
    const email = nullable(dto.email);
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new BadRequestException('That contact email does not look like a valid address.');
    }
    const data = {
      phone: nullable(dto.phone),
      email,
      linkedinUrl: asUrl(dto.linkedinUrl),
      githubUrl: asUrl(dto.githubUrl),
      portfolioUrl: asUrl(dto.portfolioUrl),
      city: nullable(dto.city),
      careerSummary: nullable(dto.careerSummary),
    };
    await this.prisma.studentProfile.upsert({
      where: { studentId },
      update: data,
      create: { studentId, ...data },
    });
    return { ok: true };
  }

  async setOptOut(studentId: string, optOut: boolean): Promise<{ ok: true }> {
    await this.prisma.studentProfile.upsert({
      where: { studentId },
      update: { leaderboardOptOut: optOut },
      create: { studentId, leaderboardOptOut: optOut },
    });
    return { ok: true };
  }

  async setTarget(studentId: string, hours: number): Promise<{ ok: true }> {
    if (!Number.isFinite(hours) || hours < 1 || hours > 60) {
      throw new BadRequestException('Choose a target between 1 and 60 hours a week.');
    }
    await this.prisma.student.update({
      where: { id: studentId },
      data: { weeklyHourTarget: Math.round(hours * 2) / 2 },
    });
    return { ok: true };
  }
}
