import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  Bookmark,
  CircleHelp,
  LayoutGrid,
  Map,
  Navigation,
} from 'lucide-react';

export default function SideNav() {
  return (
    <nav className="app-rail" aria-label="Main navigation">
      <span className="rail-caption">EXPLORE</span>
      {[
        { to: '/', label: 'Navigate', icon: Map },
        { to: '/directory', label: 'Directory', icon: LayoutGrid },
        { to: '/saved', label: 'Saved', icon: Bookmark },
      ].map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({ isActive }) =>
            `rail-link ${isActive ? 'is-active' : ''}`
          }
        >
          <Icon size={21} />
          <span>{label}</span>
        </NavLink>
      ))}
      <div className="rail-bottom">
        <span className="rail-mini-logo">
          <Navigation size={18} />
        </span>
        <NavLink
          to="/help"
          className={({ isActive }) =>
            `rail-link ${isActive ? 'is-active' : ''}`
          }
        >
          <CircleHelp size={21} />
          <span>Help</span>
        </NavLink>
      </div>
    </nav>
  );
}
