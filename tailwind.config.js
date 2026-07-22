/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Cozy gray palette
        surface: {
          50:  '#fafafa',
          100: '#f5f5f5',
          200: '#e8e8e8',
          300: '#d6d6d6',
          400: '#a3a3a3',
          500: '#737373',
          600: '#525252',
          700: '#404040',
          800: '#2a2a2a',
          900: '#1a1a1a',
          950: '#0f0f0f',
        },
        accent: {
          50:  '#fef6ee',
          100: '#fdead7',
          200: '#fad0ae',
          300: '#f6af7a',
          400: '#f18445',
          500: '#ee6622',
          600: '#df4e18',
          700: '#b93a16',
          800: '#93301a',
          900: '#772a19',
        },
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"Cascadia Code"', '"Fira Code"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        'xl': '0.75rem',
        '2xl': '1rem',
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
