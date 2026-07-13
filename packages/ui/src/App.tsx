import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { DevCycleRunDetailPage } from './pages/DevCycleRunDetailPage';
import { HomePage } from './pages/HomePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ChatPage } from './pages/ChatPage';
import { ChatStartPage } from './pages/ChatStartPage';
import { TiersPage } from './pages/TiersPage';
import { SettingsPage } from './pages/SettingsPage';
import { BudgetsPage } from './pages/BudgetsPage';

const NAV_LINKS = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/projects', label: 'Projects' },
  { to: '/chat', label: 'Chat' },
  { to: '/tiers', label: 'Tiers' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <BrowserRouter>
      <Toaster />
      <header className="border-b bg-background">
        <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
          <span className="text-sm font-semibold">Agentic Ops</span>
          <div className="flex gap-4">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  `text-sm font-medium transition-colors ${
                    isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/dashboard" element={<HomePage />} />
        <Route path="/runs/:workflowId" element={<RunDetailPage />} />
        <Route path="/dev-runs/:workflowId" element={<DevCycleRunDetailPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/chat" element={<ChatStartPage />} />
        <Route path="/chats/:chatId" element={<ChatPage />} />
        <Route path="/tiers" element={<TiersPage />} />
        <Route path="/budgets" element={<BudgetsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}