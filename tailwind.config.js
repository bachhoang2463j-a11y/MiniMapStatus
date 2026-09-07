/** MiniMapStatus Tailwind 构建期配置（自源 HTML 原 内联 tailwind.config 迁出；
 *  运行时编译器 cdn.tailwindcss.com 已移除，改由 build_tailwind.mjs 构建期编译内联） */
module.exports = {
  content: ['./MiniMapStatus.html'],
  theme: {
    extend: {
      colors: {
        primary: '#9d7cf5',
        secondary: '#2d2447',
        dark: '#2a1f3d',
        light: '#1e1831',
        lightBg: '#f8fafc',
        lightCard: '#ffffff',
        lightText: '#1e293b',
        lightBorder: '#e2e8f0',
        darkBorder: '#332a50',
        jade: {
          50: '#faf5f5', 100: '#f5e6e6', 200: '#e8c4c4', 300: '#d4a3a3', 400: '#b87070',
          500: '#8b4545', 600: '#6b2d2d', 700: '#521f1f', 800: '#3d1818', 900: '#2a1010',
        },
        classic: {
          50: '#fefbf5', 100: '#fdf6e9', 200: '#faeed7', 300: '#f5dfb7', 400: '#e9c887',
          500: '#d9a856', 600: '#c28c40', 700: '#a06c30', 800: '#7d5428', 900: '#644423',
        },
        romantic: {
          50: '#fef7f7', 100: '#fdeaea', 200: '#fbdadb', 300: '#f7bfc1', 400: '#f097a0',
          500: '#e36774', 600: '#d14455', 700: '#b12d3e', 800: '#942738', 900: '#7e2635',
        },
        fresh: {
          50: '#f0fdf9', 100: '#dcfce7', 200: '#bbf7d0', 300: '#86efac', 400: '#4ade80',
          500: '#22c55e', 600: '#16a34a', 700: '#15803d', 800: '#166534', 900: '#14532d',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        serif: ['Georgia', 'Cambria', 'serif'],
      },
    },
  },
};
