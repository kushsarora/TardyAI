import React from 'react';
import { ArrowUpRight, GraduationCap, Navigation } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DEMO_MODE } from '@/lib/tardyApi';

export default function TopNav({ title = 'TardyAI' }: { title?: string }) {
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-icon">
          <Navigation size={22} fill="currentColor" />
        </span>
        <span>
          {title}
          <span className="brand-period">.</span>
        </span>
      </Link>
      <div className="header-campus">
        <GraduationCap size={18} />
        <span>University of Wisconsin–Madison</span>
        <span className="header-divider" />
        <span className="header-muted">Campus navigator</span>
      </div>
      <div className="header-right">
        <span className="connection-badge">
          <i />
          {DEMO_MODE ? 'Building demo' : 'Connected'}
        </span>
        <a href="#/help" className="header-help">
          How it works <ArrowUpRight size={14} />
        </a>
        <span className="campus-avatar" title="UW–Madison">
          W
        </span>
      </div>
    </header>
  );
}
