import { describe, expect, it } from 'bun:test';
import { buildCreatorAdminCommand } from '../../src/commands/index';

function listOptionNames(command: ReturnType<typeof buildCreatorAdminCommand>) {
  const data = command.toJSON();
  return (data.options ?? []).map((option) => option.name);
}

describe('creator-admin command registry', () => {
  it('keeps setup as the single onboarding entrypoint', () => {
    const unconfiguredCommand = buildCreatorAdminCommand(false);
    const configuredCommand = buildCreatorAdminCommand(true);

    expect(listOptionNames(unconfiguredCommand)).toContain('setup');
    expect(listOptionNames(configuredCommand)).toContain('dashboard');
    expect(listOptionNames(unconfiguredCommand)).not.toContain('autosetup');
    expect(listOptionNames(configuredCommand)).not.toContain('autosetup');
  });
});
