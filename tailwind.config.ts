import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        studio: {
          50: '#f5f7fb',
          100: '#e8eef7',
          200: '#c9d7ea',
          300: '#9fb4d4',
          400: '#7390bc',
          500: '#4e6e9c',
          600: '#355174',
          700: '#203248',
          800: '#151f2d',
          900: '#0d131b',
          950: '#070b10'
        }
      },
      boxShadow: {
        panel: '0 18px 60px rgba(7, 11, 16, 0.35)'
      },
      keyframes: {
        slowZoomIn: {
          '0%': { transform: 'scale(1) translate3d(0, 0, 0)' },
          '100%': { transform: 'scale(1.14) translate3d(-2%, -2%, 0)' }
        },
        slowZoomOut: {
          '0%': { transform: 'scale(1.14) translate3d(-2%, -2%, 0)' },
          '100%': { transform: 'scale(1) translate3d(0, 0, 0)' }
        },
        slowPanLeft: {
          '0%': { transform: 'scale(1.08) translate3d(2%, 0, 0)' },
          '100%': { transform: 'scale(1.08) translate3d(-3%, 0, 0)' }
        },
        slowPanRight: {
          '0%': { transform: 'scale(1.08) translate3d(-3%, 0, 0)' },
          '100%': { transform: 'scale(1.08) translate3d(2%, 0, 0)' }
        },
        slowPanUp: {
          '0%': { transform: 'scale(1.08) translate3d(0, 3%, 0)' },
          '100%': { transform: 'scale(1.08) translate3d(0, -3%, 0)' }
        },
        slowPanDown: {
          '0%': { transform: 'scale(1.08) translate3d(0, -3%, 0)' },
          '100%': { transform: 'scale(1.08) translate3d(0, 3%, 0)' }
        },
        fadeInPulse: {
          '0%, 100%': { opacity: '0.92' },
          '50%': { opacity: '1' }
        }
      },
      animation: {
        slowZoomIn: 'slowZoomIn 10s ease-in-out infinite alternate',
        slowZoomOut: 'slowZoomOut 10s ease-in-out infinite alternate',
        slowPanLeft: 'slowPanLeft 10s ease-in-out infinite alternate',
        slowPanRight: 'slowPanRight 10s ease-in-out infinite alternate',
        slowPanUp: 'slowPanUp 10s ease-in-out infinite alternate',
        slowPanDown: 'slowPanDown 10s ease-in-out infinite alternate',
        fadeInPulse: 'fadeInPulse 6s ease-in-out infinite'
      }
    }
  },
  plugins: []
};

export default config;
