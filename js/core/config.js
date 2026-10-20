// config.js - public site configuration. The gallery key is Supabase's *anon* key: it is meant to be public (row level
// security in docs/gallery.sql decides what it may do).
(function (root) {
  'use strict';
  const VH = root.VH = root.VH || {};
  VH.config = Object.assign(VH.config || {}, {
    gallery: {
      url: 'https://ctbqbqpawtxtxhltpfnc.supabase.co',
      key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0YnFicXBhd3R4dHhobHRwZm5jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MDQwMDMsImV4cCI6MjEwODA4MDAwM30.Vicv9VLolXXCwL6M4lKMT02wRbnQluom5hD7OoET13w',
    },
  });
  if (typeof module === 'object' && module.exports) module.exports = VH.config;
})(typeof window !== 'undefined' ? window : globalThis);
