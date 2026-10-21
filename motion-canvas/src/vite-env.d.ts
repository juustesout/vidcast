/// <reference types="vite/client" />

declare module '*?scene' {
  const description: import('@motion-canvas/core').FullSceneDescription;
  export default description;
}

declare module '*?project' {
  import type {Project} from '@motion-canvas/core';
  const project: Project;
  export default project;
}
