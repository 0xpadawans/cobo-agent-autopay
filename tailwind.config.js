/** @type {import('tailwindcss').Config} */
/* eslint-disable @typescript-eslint/no-require-imports */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        sidebar: '#0A1628',
        'sidebar-hover': '#1A2940',
        'sidebar-active': '#2563EB',
        'page-bg': '#F8FAFC',
        'card-bg': '#FFFFFF',
      }
    },
  },
  plugins: [require('@tailwindcss/forms')],
}
