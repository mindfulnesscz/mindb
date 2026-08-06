// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import { CdnGarbageCollectionCard } from './CdnGarbageCollectionCard';

afterEach(() => {
  cleanup();
  useAuthStore.setState({ profile: null });
  useEnvironmentStore.setState({ environments: [], activeEnvId: null });
});

describe('desktop CdnGarbageCollectionCard access', () => {
  it('renders the Analyze control for a super admin with an active environment', () => {
    useAuthStore.setState({
      profile: { id: 'user-1', name: 'Super Admin', role: 'super_admin' },
    });
    useEnvironmentStore.setState({
      activeEnvId: 'local',
      environments: [{ id: 'local', name: 'Local', supabaseUrl: 'http://localhost:54321', anonKey: 'anon' }],
    });

    render(createElement(CdnGarbageCollectionCard));
    expect(screen.getByText('CDN garbage collection')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Analyze' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('is absent for ordinary admins', () => {
    useAuthStore.setState({ profile: { id: 'user-2', name: 'Admin', role: 'admin' } });
    const { container } = render(createElement(CdnGarbageCollectionCard));
    expect(container.innerHTML).toBe('');
  });
});
