/**
 * Placement offers — the candidacy loop REEP was missing.
 *
 * A student records an offer they received (on- or off-campus), carrying the
 * things a placement report actually needs — role, organisation, compensation,
 * the offer letter — as a DRAFT they can edit, then SUBMITS it, which locks the
 * record and routes it to a director. This is the port of pod.ai's
 * /offers/create, and it turns the self-reported "I applied" tick into a real,
 * approvable outcome trail.
 *
 * The lock is the point: once submitted, the student can no longer edit it —
 * a placement report must not read a figure the student changed after approval.
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { OfferChannel, OfferRoleType, OfferWorkMode, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export interface OfferInput {
  roleType: OfferRoleType;
  jobTitle: string;
  organisation: string;
  channel?: OfferChannel;
  jobId?: string | null;
  joiningDate?: string | null;
  workMode?: OfferWorkMode;
  location?: string | null;
  ctcInr?: number;
  fixedGrossInr?: number;
  bonuses?: { label: string; amountInr: number }[];
  offerLetterUploadId?: string | null;
  loiUploadId?: string | null;
  jobDescription?: string | null;
  bondDetails?: string | null;
  otherBenefits?: string | null;
}

const OFFER_SELECT = {
  id: true,
  roleType: true,
  jobTitle: true,
  organisation: true,
  channel: true,
  joiningDate: true,
  workMode: true,
  location: true,
  ctcInr: true,
  fixedGrossInr: true,
  bonuses: true,
  offerLetterUploadId: true,
  loiUploadId: true,
  jobDescription: true,
  bondDetails: true,
  otherBenefits: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
} satisfies Prisma.PlacementOfferSelect;

@Injectable()
export class OffersService {
  constructor(private readonly prisma: PrismaService) {}

  listMine(studentId: string) {
    return this.prisma.placementOffer.findMany({
      where: { studentId },
      select: OFFER_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(studentId: string, input: OfferInput) {
    this.validate(input);
    return this.prisma.placementOffer.create({
      data: { studentId, status: 'DRAFT', ...this.toData(input) },
      select: OFFER_SELECT,
    });
  }

  async update(studentId: string, id: string, input: OfferInput) {
    const existing = await this.owned(studentId, id);
    if (existing.status !== 'DRAFT') {
      // Once submitted it is locked; an approved CTC a student could still edit
      // would make the placement report worthless.
      throw new ForbiddenException('This offer has been submitted and can no longer be edited.');
    }
    this.validate(input);
    return this.prisma.placementOffer.update({
      where: { id },
      data: this.toData(input),
      select: OFFER_SELECT,
    });
  }

  /// Lock the record and route it to a director. Irreversible from the student
  /// side, matching the "once applied for approval you cannot edit" note pod.ai
  /// shows on its offer form.
  async submit(studentId: string, id: string) {
    const existing = await this.owned(studentId, id);
    if (existing.status !== 'DRAFT') {
      throw new ForbiddenException('This offer has already been submitted.');
    }
    return this.prisma.placementOffer.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL' },
      select: OFFER_SELECT,
    });
  }

  private async owned(studentId: string, id: string) {
    const offer = await this.prisma.placementOffer.findUnique({
      where: { id },
      select: { id: true, studentId: true, status: true },
    });
    if (!offer || offer.studentId !== studentId) {
      // Same answer for "not found" and "not yours" — never confirm another
      // student's offer id exists.
      throw new NotFoundException('No such offer.');
    }
    return offer;
  }

  private validate(input: OfferInput): void {
    if (!input.jobTitle?.trim()) throw new BadRequestException('A job title is required.');
    if (!input.organisation?.trim()) throw new BadRequestException('An organisation is required.');
    if ((input.ctcInr ?? 0) < 0 || (input.fixedGrossInr ?? 0) < 0) {
      throw new BadRequestException('Compensation cannot be negative.');
    }
    for (const b of input.bonuses ?? []) {
      if (!b.label?.trim() || !Number.isFinite(b.amountInr) || b.amountInr < 0) {
        throw new BadRequestException('Each bonus needs a label and a non-negative amount.');
      }
    }
  }

  private toData(
    input: OfferInput,
  ): Omit<Prisma.PlacementOfferUncheckedCreateInput, 'id' | 'studentId' | 'status'> {
    return {
      roleType: input.roleType,
      jobTitle: input.jobTitle.trim(),
      organisation: input.organisation.trim(),
      channel: input.channel ?? 'ON_CAMPUS',
      jobId: input.jobId ?? null,
      joiningDate: input.joiningDate ? new Date(input.joiningDate) : null,
      workMode: input.workMode ?? 'ONSITE',
      location: input.location?.trim() || null,
      ctcInr: Math.round(input.ctcInr ?? 0),
      fixedGrossInr: Math.round(input.fixedGrossInr ?? 0),
      bonuses: (input.bonuses ?? []) as unknown as Prisma.InputJsonValue,
      offerLetterUploadId: input.offerLetterUploadId ?? null,
      loiUploadId: input.loiUploadId ?? null,
      jobDescription: input.jobDescription?.trim() || null,
      bondDetails: input.bondDetails?.trim() || null,
      otherBenefits: input.otherBenefits?.trim() || null,
    };
  }
}
