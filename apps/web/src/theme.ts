import { createTheme, MantineColorsTuple } from '@mantine/core';

const brand: MantineColorsTuple = [
  '#e6f7ff',
  '#cceaff',
  '#99d6ff',
  '#66c2ff',
  '#33adff',
  '#00a0ff',
  '#0080cc',
  '#006099',
  '#004066',
  '#002033',
];

export const theme = createTheme({
  primaryColor: 'brand',
  colors: {
    brand,
  },
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
  defaultRadius: 'md',
});
