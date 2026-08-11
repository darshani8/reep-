/**
 * ResumeContent → markdown.
 *
 * Deliberately flat: headings, bullets and plain text only. Most ATS parsers
 * choke on tables and multi-column layouts, and this is the copy a student will
 * paste into a portal, so it stays boring on purpose.
 */

import type { ResumeContent } from './resume-types';

export function renderResumeMarkdown(content: ResumeContent): string {
  const { header } = content;
  const lines: string[] = [];

  lines.push(`# ${header.name}`);

  const contact = [header.city, header.email, header.phone, `USN ${header.usn}`].filter(
    Boolean,
  );
  if (contact.length > 0) lines.push(contact.join(' · '));

  const links = [header.linkedinUrl, header.githubUrl, header.portfolioUrl].filter(Boolean);
  if (links.length > 0) lines.push(links.join(' · '));

  if (header.headline) lines.push('', `**${header.headline}**`);

  if (content.summary) {
    lines.push('', '## Professional Summary', '', content.summary);
  }

  if (content.education.length > 0) {
    lines.push('', '## Education', '');
    for (const entry of content.education) {
      const tail = [entry.year, entry.score].filter(Boolean).join(' · ');
      lines.push(
        `- **${entry.degree}** — ${entry.institution}${tail ? ` (${tail})` : ''}`,
      );
    }
  }

  if (content.experience.length > 0) {
    lines.push('', '## Experience');
    for (const role of content.experience) {
      lines.push('', `### ${role.title}${role.org ? ` — ${role.org}` : ''}`);
      if (role.period) lines.push(`*${role.period}*`);
      lines.push('');
      for (const bullet of role.bullets) lines.push(`- ${bullet.text}`);
    }
  }

  if (content.projects.length > 0) {
    lines.push('', '## Projects');
    for (const project of content.projects) {
      lines.push('', `### ${project.name}`);
      if (project.description) lines.push(project.description);
      if (project.tech.length > 0) lines.push(`*Tech:* ${project.tech.join(', ')}`);
      if (project.link) lines.push(`*Link:* ${project.link}`);
    }
  }

  if (content.certifications.length > 0) {
    lines.push('', '## Certifications', '');
    for (const cert of content.certifications) {
      const meta = [cert.provider, `${cert.hours}h`, cert.completedOn, cert.courseCode]
        .filter(Boolean)
        .join(' · ');
      lines.push(`- **${cert.name}** — ${meta}`);
    }
  }

  if (content.reepHighlights.length > 0) {
    lines.push('', '## REEP Programme Record', '');
    for (const highlight of content.reepHighlights) {
      lines.push(`- **${highlight.label}:** ${highlight.detail}`);
    }
  }

  const skillGroups: [string, string[]][] = [
    ['Technical & analytical', content.skills.technical],
    ['Professional & behavioural', content.skills.professional],
    ['Tools', content.skills.tools],
  ];
  if (skillGroups.some(([, items]) => items.length > 0)) {
    lines.push('', '## Skills', '');
    for (const [label, items] of skillGroups) {
      if (items.length > 0) lines.push(`**${label}:** ${items.join(', ')}`);
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/// Flat text used by the ATS keyword check — headings and markers stripped.
export function resumePlainText(content: ResumeContent): string {
  return renderResumeMarkdown(content)
    .replace(/[#*_`>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
