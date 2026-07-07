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
        // Semantic status colors, tuned to read on both the light `bg-gray-200`
        // (#e5e7eb) and dark `bg-gray-800` (#1f2937) surfaces. Use the DEFAULT for
        // fills / dark-mode text, the 600/700 steps for text on light surfaces.
        danger: {
          DEFAULT: '#ef4444', // red-500
          600: '#dc2626', // red-600 - text on light surfaces
          700: '#b91c1c', // red-700
        },
        // Downloaded / done indicators.
        success: {
          DEFAULT: '#22c55e', // green-500
          600: '#16a34a', // green-600 - text on light surfaces
          700: '#15803d', // green-700
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
