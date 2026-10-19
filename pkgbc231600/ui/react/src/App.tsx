/*
 * Copyright 2009-2026 C3 AI (www.c3.ai). All Rights Reserved.
 * Confidential and Proprietary C3 Materials.
 * This material, including without limitation any software, is the confidential trade secret and proprietary
 * information of C3 and its licensors. Reproduction, use and/or distribution of this material in any form is
 * strictly prohibited except as set forth in a written license agreement with C3 and/or its authorized distributors.
 * This material may be covered by one or more patents or pending patent applications.
 */

import React from 'react';
import { Route, Routes } from 'react-router-dom';
import Navigate from './pages/Navigate/Navigate';
import RoomFinder from './pages/RoomFinder/RoomFinder';
import SideNav from './components/SideNav/SideNav';
import TopNav from './components/TopNav/TopNav';
import ErrorReporterProvider from './components/ErrorBoundary/ErrorBoundary';

/** Persistent application header and navigation, with a responsive map workspace. */
export default function App() {
  return (
    <ErrorReporterProvider>
      <div className="tardy-app">
        <TopNav title="TardyAI" />
        <div className="app-body">
          <SideNav />
          <div className="app-content">
            <main className="app-main">
              <Routes>
                {/* Add page routes here */}
                <Route path="/" element={<Navigate />} />
                <Route path="/navigate" element={<Navigate />} />
                <Route path="/room-finder" element={<RoomFinder />} />
                <Route path="/directory" element={<Navigate />} />
                <Route path="/saved" element={<Navigate />} />
                <Route path="/help" element={<Navigate />} />
                <Route
                  path="*"
                  element={
                    <div className="empty-page">
                      <h1>Page not found</h1>
                      <a href="#/">Back to the map</a>
                    </div>
                  }
                />
              </Routes>
            </main>
          </div>
        </div>
      </div>
    </ErrorReporterProvider>
  );
}
