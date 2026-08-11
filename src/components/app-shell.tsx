'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { AgentLauncher } from '@/components/agent-launcher';

import AppBar from '@mui/material/AppBar';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';

import AssessmentOutlined from '@mui/icons-material/AssessmentOutlined';
import ChatBubbleOutlineOutlined from '@mui/icons-material/ChatBubbleOutlineOutlined';
import CloudUploadOutlined from '@mui/icons-material/CloudUploadOutlined';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import DescriptionOutlined from '@mui/icons-material/DescriptionOutlined';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';
import GroupsOutlined from '@mui/icons-material/GroupsOutlined';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import InsightsOutlined from '@mui/icons-material/InsightsOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import LogoutOutlined from '@mui/icons-material/LogoutOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import MenuRounded from '@mui/icons-material/MenuRounded';
import NotificationsNoneOutlined from '@mui/icons-material/NotificationsNoneOutlined';
import PersonOutlineOutlined from '@mui/icons-material/PersonOutlineOutlined';
import PersonSearchOutlined from '@mui/icons-material/PersonSearchOutlined';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import SupervisorAccountOutlined from '@mui/icons-material/SupervisorAccountOutlined';
import TuneOutlined from '@mui/icons-material/TuneOutlined';
import WorkOutlineOutlined from '@mui/icons-material/WorkOutlineOutlined';
import WorkspacePremiumOutlined from '@mui/icons-material/WorkspacePremiumOutlined';

const DRAWER_WIDTH = 236;

export type ShellRole = 'student' | 'mentor' | 'director';

type NavEntry = { href: string; label: string; icon: ReactNode };

/// Nav lives here rather than in the server layout because each entry carries an
/// icon component, which cannot cross the server/client boundary as a prop.
const NAV: Record<ShellRole, NavEntry[]> = {
  student: [
    { href: '/student', label: 'Overview', icon: <HomeOutlined /> },
    { href: '/student/certifications', label: 'Certifications', icon: <WorkspacePremiumOutlined /> },
    { href: '/student/time-log', label: 'Time log', icon: <ScheduleOutlined /> },
    { href: '/student/courses', label: 'Courses', icon: <MenuBookOutlined /> },
    { href: '/student/uploads', label: 'Uploads', icon: <CloudUploadOutlined /> },
    { href: '/student/resume', label: 'Resume', icon: <DescriptionOutlined /> },
    { href: '/student/assistant', label: 'REEP Agent', icon: <ChatBubbleOutlineOutlined /> },
    { href: '/student/profile', label: 'Profile', icon: <PersonOutlineOutlined /> },
  ],
  mentor: [
    { href: '/mentor', label: 'Cohort', icon: <GroupsOutlined /> },
    { href: '/mentor/student', label: 'Students', icon: <PersonSearchOutlined /> },
    { href: '/mentor/alerts', label: 'Alerts', icon: <NotificationsNoneOutlined /> },
    { href: '/mentor/uploads', label: 'Verifications', icon: <FactCheckOutlined /> },
    { href: '/mentor/reports', label: 'Reports', icon: <AssessmentOutlined /> },
    { href: '/mentor/assistant', label: 'REEP Agent', icon: <ChatBubbleOutlineOutlined /> },
    { href: '/mentor/settings', label: 'Thresholds', icon: <TuneOutlined /> },
  ],
  director: [
    { href: '/director', label: 'Analytics', icon: <InsightsOutlined /> },
    { href: '/director/mentors', label: 'Mentor assignment', icon: <SupervisorAccountOutlined /> },
    { href: '/director/courses', label: 'Courses', icon: <MenuBookOutlined /> },
    { href: '/director/certifications', label: 'Certifications', icon: <WorkspacePremiumOutlined /> },
    { href: '/director/placement', label: 'Placement', icon: <WorkOutlineOutlined /> },
    { href: '/director/assistant', label: 'REEP Agent', icon: <ChatBubbleOutlineOutlined /> },
    { href: '/director/exports', label: 'Exports', icon: <DownloadOutlined /> },
  ],
};

const ROLE_LABEL: Record<ShellRole, string> = {
  student: 'Student',
  mentor: 'Faculty mentor',
  director: 'Programme director',
};

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  // /mentor must not light up for /mentor/alerts, but /mentor/student must
  // light up for /mentor/student/<id>.
  return href !== '/' && pathname.startsWith(`${href}/`);
}

export function AppShell({
  role,
  userName,
  userMeta,
  children,
}: {
  role: ShellRole;
  userName: string;
  userMeta?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);

  const items = NAV[role];

  const initials = userName
    .replace(/^(Prof\.|Dr\.|Mr\.|Ms\.)\s*/i, '')
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const drawer = (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ px: 3, pt: 3.5, pb: 3 }}>
        <Typography
          sx={{ fontSize: '0.9375rem', fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1 }}
        >
          REEP
        </Typography>
        <Typography variant="caption" color="text.disabled" sx={{ mt: 0.5, display: 'block' }}>
          {ROLE_LABEL[role]}
        </Typography>
      </Box>

      <List sx={{ px: 1.5, flex: 1, py: 0 }}>
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <ListItem key={item.href} disablePadding sx={{ mb: 0.25 }}>
              <ListItemButton
                component={Link}
                href={item.href}
                selected={active}
                onClick={() => setMobileOpen(false)}
                aria-current={active ? 'page' : undefined}
                sx={{
                  color: active ? 'text.primary' : 'text.secondary',
                  '&.Mui-selected': { bgcolor: 'action.hover' },
                  '&.Mui-selected:hover': { bgcolor: 'action.hover' },
                }}
              >
                <ListItemIcon
                  sx={{
                    minWidth: 32,
                    color: active ? 'secondary.main' : 'text.disabled',
                    '& svg': { fontSize: 19 },
                  }}
                >
                  {item.icon}
                </ListItemIcon>
                <ListItemText
                  primary={item.label}
                  slotProps={{
                    primary: {
                      sx: { fontSize: '0.875rem', fontWeight: active ? 600 : 400 },
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      <Box sx={{ px: 3, py: 2.5 }}>
        <Typography variant="caption" color="text.disabled">
          BGSCET MBA
        </Typography>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Every page puts the app bar and a 6–7 item drawer before the content.
          Without a bypass that is ~10 tab stops on every single navigation. */}
      <Box component="a" href="#main" className="skip-link no-print">
        Skip to content
      </Box>

      <AppBar
        position="fixed"
        elevation={0}
        className="no-print"
        sx={{
          width: { lg: `calc(100% - ${DRAWER_WIDTH}px)` },
          ml: { lg: `${DRAWER_WIDTH}px` },
          bgcolor: 'background.default',
          color: 'text.primary',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Toolbar sx={{ gap: 1, minHeight: { xs: 56, sm: 60 } }}>
          <IconButton
            edge="start"
            onClick={() => setMobileOpen(true)}
            sx={{ display: { lg: 'none' } }}
            aria-label="Open navigation"
          >
            <MenuRounded />
          </IconButton>

          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="subtitle2" noWrap sx={{ lineHeight: 1.3 }}>
              {userName}
            </Typography>
            {userMeta ? (
              <Typography variant="caption" color="text.disabled" noWrap component="div">
                {userMeta}
              </Typography>
            ) : null}
          </Box>

          <ThemeToggle />

          <Tooltip title="Account">
            {/* The name has to start with the monogram, because the monogram is
                what is on screen. WCAG 2.5.3 is about speech input: the button
                read "SM" and answered to "Account menu", so a voice-control user
                saying what they could see never reached it. Hiding the initials
                from assistive tech does not fix that — they are still the
                visible label — so the name is widened to contain them. */}
            <IconButton
              onClick={(event) => setAnchor(event.currentTarget)}
              aria-label={`${initials}, account menu`}
            >
              <Avatar
                sx={{
                  width: 30,
                  height: 30,
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  bgcolor: 'action.selected',
                  // Ink, not the accent. The accent on this tinted circle is
                  // 4.29:1 in light — under the floor for 12px — and the
                  // obvious swap to secondary.dark fixes light (6.21:1) while
                  // breaking dark (3.85:1), because the token flips with the
                  // scheme and the backdrop does not flip with it. Ink clears
                  // both by a wide margin (12.87:1 / 12.78:1) and the tinted
                  // circle still carries the accent.
                  color: 'text.primary',
                }}
              >
                {initials}
              </Avatar>
            </IconButton>
          </Tooltip>

          <Menu
            anchorEl={anchor}
            open={Boolean(anchor)}
            onClose={() => setAnchor(null)}
            slotProps={{ paper: { sx: { border: 1, borderColor: 'divider', minWidth: 190 } } }}
          >
            <Box sx={{ px: 2, py: 1.25 }}>
              <Typography variant="subtitle2">{userName}</Typography>
              <Typography variant="caption" color="text.disabled">
                {ROLE_LABEL[role]}
              </Typography>
            </Box>
            <Divider />
            {/* The form wraps the item rather than being the item: MenuItem's
                overridable props do not carry `action`/`method`. */}
            <Box component="form" action="/api/auth/logout" method="post">
              <MenuItem component="button" type="submit" sx={{ width: '100%', gap: 1.5 }}>
                <LogoutOutlined sx={{ fontSize: 18 }} />
                Sign out
              </MenuItem>
            </Box>
          </Menu>
        </Toolbar>
      </AppBar>

      <Box
        component="nav"
        aria-label={`${ROLE_LABEL[role]} sections`}
        sx={{
          width: { lg: DRAWER_WIDTH },
          flexShrink: { lg: 0 },
        }}
      >
        {/*
          Two drawers, and CSS picks — not one drawer with a JS breakpoint.

          `useMediaQuery` cannot know the viewport on the server, so it returned
          false there and the drawer rendered `temporary` + closed, which emits
          *nothing*. Every server-rendered page therefore shipped with no
          navigation in it at all: no links for a crawler or a reader whose JS
          has not arrived, and a 236px layout shift on every full load as the
          permanent drawer mounted and pushed the main column right.

          The MUI docs are explicit about this — "server-side rendering and
          client-side media queries are fundamentally at odds; try relying on
          client-side CSS media queries first". Both drawers are in the HTML and
          the breakpoint hides one, so the nav is server-rendered either way.
        */}
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          className="no-print"
          slotProps={{ root: { keepMounted: true } }}
          sx={{
            display: { xs: 'block', lg: 'none' },
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
            },
          }}
        >
          {drawer}
        </Drawer>

        <Drawer
          variant="permanent"
          open
          className="no-print"
          sx={{
            display: { xs: 'none', lg: 'block' },
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
            },
          }}
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        id="main"
        tabIndex={-1}
        sx={{
          flexGrow: 1,
          minWidth: 0,
          width: { lg: `calc(100% - ${DRAWER_WIDTH}px)` },
          // Focused programmatically by the skip link; it should not draw a
          // ring around the entire page when it receives that focus.
          '&:focus': { outline: 'none' },
        }}
      >
        <Toolbar className="no-print" sx={{ minHeight: { xs: 56, sm: 60 } }} />
        {/* A measured column rather than full bleed: long rows of text are
            harder to scan the wider they run. */}
        <Box
          sx={{
            px: { xs: 2.5, sm: 4, lg: 6 },
            py: { xs: 4, sm: 5 },
            maxWidth: 1240,
            // Room for the floating launcher, so it never sits on top of the
            // last row of a table or the final button on a form.
            pb: { xs: 12, sm: 13 },
          }}
        >
          {children}
        </Box>
      </Box>

      {/* Every screen in the product renders through here, which is the point:
          the agent is reachable without navigating away from what you are
          reading. It fetches nothing until opened. */}
      <AgentLauncher />
    </Box>
  );
}

function ThemeToggle() {
  const { mode, setMode } = useColorScheme();

  return (
    <Tooltip title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
      <IconButton
        onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
        aria-label="Toggle colour mode"
        sx={{ color: 'text.disabled' }}
      >
        {mode === 'dark' ? (
          <LightModeOutlined sx={{ fontSize: 19 }} />
        ) : (
          <DarkModeOutlined sx={{ fontSize: 19 }} />
        )}
      </IconButton>
    </Tooltip>
  );
}
