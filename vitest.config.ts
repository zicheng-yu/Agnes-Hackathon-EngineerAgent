import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],test:{environment:'jsdom',include:['tests/ui/**/*.test.{ts,tsx}'],setupFiles:['tests/ui/setup.ts'],restoreMocks:true,clearMocks:true}});
