import { createManualProviderModule } from '@yucp/providers/manual/module';
import { defineApiProviderEntry } from '../types';

const manualProvider = defineApiProviderEntry({
  runtime: createManualProviderModule(),
  hooks: {},
});

export default manualProvider;
