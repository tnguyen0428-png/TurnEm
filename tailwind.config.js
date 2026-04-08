/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        bebas: ['Arial Narrow', 'Arial', 'Helvetica', 'sans-serif'],
        mono: ['Arial Narrow', 'Arial', 'Helvetica', 'sans-serif'],
      },
      colors: {
        salon: {
          bg: '#fafafa',
          card: '#ffffff',
          border: '#e5e7eb',
          text: '#111827',
          muted: '#6b7280',
          accent: '#ec4899',
        },
      },
    },
  },
  plugins: [],
};
