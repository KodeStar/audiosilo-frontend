/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand accent - Tailwind pink-600, ported from the old client.
        primary: {
          DEFAULT: '#db2777',
          50: '#fdf2f8',
          100: '#fce7f3',
          200: '#fbcfe8',
          300: '#f9a8d4',
          400: '#f472b6',
          500: '#ec4899',
          600: '#db2777',
          700: '#be185d',
          800: '#9d174d',
          900: '#831843',
        },
        // Custom dark grays carried over from the old client.
        gray: {
          750: '#2c3340',
          840: '#1a2331',
          860: '#161f2c',
        },
      },
      fontFamily: {
        // Default body font. Per-weight families avoid clashing with
        // Tailwind's font-weight utilities (font-light / font-medium / ...).
        sans: ['Roboto_400Regular', 'system-ui', 'sans-serif'],
        'roboto-light': ['Roboto_300Light', 'system-ui', 'sans-serif'],
        'roboto-medium': ['Roboto_500Medium', 'system-ui', 'sans-serif'],
        'roboto-semibold': ['Roboto_600SemiBold', 'system-ui', 'sans-serif'],
        'roboto-bold': ['Roboto_700Bold', 'system-ui', 'sans-serif'],
      },
      width: {
        18: '4.5rem', // nav rail width, ported from old client
      },
    },
  },
  plugins: [],
};
