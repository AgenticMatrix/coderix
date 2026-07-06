/**
 * CSS module type declarations for the renderer process.
 * Allows importing .css files in TypeScript without errors.
 */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'katex/dist/katex.min.css';
