import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  Children,
  type ComponentPropsWithoutRef,
  createContext,
  isValidElement,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useState,
} from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

// The real HeroUI Autocomplete/SearchField render options in a portal that
// jsdom doesn't open, so mock the pieces the panel uses. Mirrors the package
// registry route test's HeroUI mock.
vi.mock('@heroui/react', () => {
  type AutocompleteCtx = {
    placeholder?: string;
    searchValue: string;
    selectedText: string | null;
    setSearchValue: (value: string) => void;
    selectItem: (key: string, text: string) => void;
    clear: () => void;
  };
  const AutocompleteContext = createContext<AutocompleteCtx | null>(null);

  function getNodeText(children: ReactNode): string {
    return Children.toArray(children)
      .map((child) => {
        if (typeof child === 'string' || typeof child === 'number') return String(child);
        if (!isValidElement(child)) return '';
        return getNodeText((child.props as { children?: ReactNode }).children);
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const Div = ({
    children,
    isDisabled: _isDisabled,
    isIconOnly: _isIconOnly,
    selectionMode: _selectionMode,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;

  const Button = ({
    children,
    isDisabled,
    isIconOnly: _isIconOnly,
    isPending: _isPending,
    onPress,
    type = 'button',
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <button
      type={typeof type === 'string' ? type : 'button'}
      disabled={Boolean(isDisabled)}
      onClick={() => {
        if (typeof onPress === 'function') onPress();
      }}
      {...props}
    >
      {children}
    </button>
  );

  const Chip = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );

  const ListBox = Object.assign(
    ({
      children,
      renderEmptyState,
      ...props
    }: PropsWithChildren<Record<string, unknown> & { renderEmptyState?: () => ReactNode }>) => {
      const ac = useContext(AutocompleteContext);
      const items = Children.toArray(children).filter(Boolean);
      const visible = ac
        ? items.filter((child) => {
            if (!isValidElement(child)) return true;
            const tv = String(
              (child.props as { textValue?: string }).textValue ??
                getNodeText((child.props as { children?: ReactNode }).children)
            ).toLowerCase();
            return tv.includes(ac.searchValue.toLowerCase());
          })
        : items;
      if (visible.length === 0 && typeof renderEmptyState === 'function') {
        return <div {...props}>{renderEmptyState()}</div>;
      }
      return <div {...props}>{visible}</div>;
    },
    {
      Item: ({
        children,
        id,
        textValue: _textValue,
        ...props
      }: PropsWithChildren<Record<string, unknown> & { id?: string; textValue?: string }>) => {
        const ac = useContext(AutocompleteContext);
        const label = getNodeText(children);
        if (!ac) return <div {...props}>{children}</div>;
        return (
          <button
            type="button"
            onClick={() => ac.selectItem(String(id ?? label), label)}
            {...props}
          >
            {children}
          </button>
        );
      },
      ItemIndicator: Div,
    }
  );

  const Autocomplete = Object.assign(
    ({
      children,
      onChange,
      onClear,
      placeholder,
      selectionMode: _selectionMode,
      value,
      isDisabled: _isDisabled,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => {
      const [searchValue, setSearchValue] = useState('');
      const [selectedText, setSelectedText] = useState<string | null>(null);
      return (
        <AutocompleteContext.Provider
          value={{
            placeholder: typeof placeholder === 'string' ? placeholder : undefined,
            searchValue,
            selectedText,
            setSearchValue,
            selectItem: (key, text) => {
              setSelectedText(text);
              setSearchValue('');
              if (typeof onChange === 'function') onChange(key);
            },
            clear: () => {
              setSelectedText(null);
              setSearchValue('');
              if (typeof onClear === 'function') onClear();
              if (typeof onChange === 'function') onChange(null);
            },
          }}
        >
          <div data-selected-key={typeof value === 'string' ? value : undefined} {...props}>
            {children}
          </div>
        </AutocompleteContext.Provider>
      );
    },
    {
      Trigger: Div,
      Value: (props: PropsWithChildren<Record<string, unknown>>) => {
        const ac = useContext(AutocompleteContext);
        return <div {...props}>{ac?.selectedText ?? ac?.placeholder ?? null}</div>;
      },
      ClearButton: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const ac = useContext(AutocompleteContext);
        return (
          <button type="button" onClick={() => ac?.clear()} {...props}>
            {children}
          </button>
        );
      },
      Indicator: Div,
      Popover: Div,
      Filter: ({
        children,
        filter: _filter,
        ...props
      }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
    }
  );

  const SearchField = Object.assign(
    ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
    {
      Group: Div,
      SearchIcon: Div,
      ClearButton: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const ac = useContext(AutocompleteContext);
        return (
          <button type="button" onClick={() => ac?.setSearchValue('')} {...props}>
            {children}
          </button>
        );
      },
      Input: ({ onChange, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const ac = useContext(AutocompleteContext);
        return (
          <input
            value={ac?.searchValue ?? ''}
            onChange={(event) => {
              ac?.setSearchValue(event.target.value);
              if (typeof onChange === 'function') onChange(event);
            }}
            {...props}
          />
        );
      },
    }
  );

  const Card = Object.assign(Div, {
    Header: Div,
    Content: Div,
    Footer: Div,
    Title: Div,
    Description: Div,
  });
  const Skeleton = Div;

  return {
    Autocomplete,
    Button,
    Card,
    Chip,
    Label: Div,
    ListBox,
    SearchField,
    Skeleton,
    useFilter: () => ({
      contains: (text: string, input: string) => text.toLowerCase().includes(input.toLowerCase()),
    }),
  };
});

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  })),
}));

vi.mock('@/hooks/useActiveDashboardContext', () => ({
  useActiveDashboardContext: vi.fn(() => ({
    activeGuildId: undefined,
    activeTenantId: 'creator-auth-user',
    isPersonalDashboard: true,
    selectedGuild: undefined,
    viewer: { authUserId: 'creator-auth-user' },
  })),
}));

vi.mock('@/hooks/useDashboardSession', () => ({
  isDashboardAuthError: vi.fn(() => false),
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
}));

vi.mock('@/lib/certificates', () => ({
  hasActiveCreatorBillingCapability: vi.fn(
    (
      capabilities: Array<{ capabilityKey: string; status: string }> | undefined,
      capabilityKey: string
    ) =>
      capabilities?.some(
        (capability) =>
          capability.capabilityKey === capabilityKey &&
          (capability.status === 'active' || capability.status === 'grace')
      ) ?? false
  ),
  listCreatorCertificates: vi.fn(),
}));

vi.mock('@/lib/couplingForensics', () => ({
  isCouplingTraceabilityRequiredError: vi.fn(() => false),
  listCouplingForensicsPackages: vi.fn(),
  runCouplingForensicsLookup: vi.fn(),
}));

import { CouplingForensicsPanel } from '@/components/dashboard/CouplingForensicsPanel';
import * as certificateApi from '@/lib/certificates';
import * as forensicsApi from '@/lib/couplingForensics';

const listCreatorCertificatesMock = certificateApi.listCreatorCertificates as ReturnType<
  typeof vi.fn
>;
const listCouplingForensicsPackagesMock = forensicsApi.listCouplingForensicsPackages as ReturnType<
  typeof vi.fn
>;
const runCouplingForensicsLookupMock = forensicsApi.runCouplingForensicsLookup as ReturnType<
  typeof vi.fn
>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function createCertificatesOverview(enabled: boolean) {
  return {
    workspaceKey: 'creator-profile:profile-1',
    creatorProfileId: 'profile-1',
    billing: {
      billingEnabled: true,
      status: enabled ? 'active' : 'inactive',
      allowEnrollment: enabled,
      allowSigning: enabled,
      planKey: enabled ? 'pro' : null,
      productId: enabled ? 'prod_pro' : null,
      deviceCap: enabled ? 5 : null,
      activeDeviceCount: 0,
      signQuotaPerPeriod: null,
      auditRetentionDays: enabled ? 90 : null,
      supportTier: enabled ? 'premium' : null,
      currentPeriodEnd: null,
      graceUntil: null,
      reason: enabled ? null : 'Certificate subscription required',
      capabilities: enabled
        ? [
            {
              capabilityKey: BILLING_CAPABILITY_KEYS.couplingTraceability,
              status: 'active',
            },
          ]
        : [],
    },
    devices: [],
    availablePlans: [],
    meters: [],
  };
}

describe('dashboard forensics route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCreatorCertificatesMock.mockResolvedValue(createCertificatesOverview(true));
    listCouplingForensicsPackagesMock.mockResolvedValue({
      packages: [
        {
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle',
          registeredAt: 1,
          updatedAt: 2,
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a retry UI instead of the upgrade gate when the entitlement query fails', async () => {
    listCreatorCertificatesMock.mockRejectedValue(
      new ApiError(400, { error: 'certificate lookup failed' })
    );

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument());

    expect(screen.queryByText('Creator Studio+ required')).not.toBeInTheDocument();
    expect(forensicsApi.listCouplingForensicsPackages).not.toHaveBeenCalled();
  });

  it('keeps the selected file immutable while a scan is pending', async () => {
    let resolveLookup: ((value: unknown) => void) | null = null;

    listCreatorCertificatesMock.mockResolvedValue(createCertificatesOverview(true));
    runCouplingForensicsLookupMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
    );

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const originalFile = new File(['original'], 'original.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [originalFile] } });

    await waitFor(() => expect(screen.getByText('original.zip')).toBeInTheDocument());
    const submitButton = screen.getByRole('button', { name: /find buyer/i });
    await waitFor(() => expect(submitButton).not.toBeDisabled());

    fireEvent.click(submitButton);

    await waitFor(() => expect(forensicsApi.runCouplingForensicsLookup).toHaveBeenCalledTimes(1));

    const clearButton = screen.getByRole('button', { name: /remove file/i });
    const selectedInput = document.getElementById('forensics-file');
    if (!(selectedInput instanceof HTMLInputElement)) {
      throw new Error('Selected-state forensics file input was not rendered');
    }

    await waitFor(() => expect(selectedInput).toBeDisabled());

    fireEvent.click(clearButton);
    expect(screen.getByText('original.zip')).toBeInTheDocument();

    const replacementFile = new File(['replacement'], 'replacement.zip', {
      type: 'application/zip',
    });
    fireEvent.change(selectedInput, { target: { files: [replacementFile] } });

    expect(screen.getByText('original.zip')).toBeInTheDocument();
    expect(screen.queryByText('replacement.zip')).not.toBeInTheDocument();

    resolveLookup?.({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'no_candidate_assets',
      message: 'No authorized match found.',
      candidateAssetCount: 0,
      decodedAssetCount: 0,
      results: [],
    });
  });

  it('rejects unsupported upload types before starting a scan', async () => {
    listCreatorCertificatesMock.mockResolvedValue(createCertificatesOverview(true));

    render(<CouplingForensicsPanel />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const upload = new File(['plain text'], 'leak.txt', { type: 'text/plain' });
    fireEvent.change(fileInput, { target: { files: [upload] } });

    await waitFor(() =>
      expect(
        screen.getByText('Unsupported file type. Upload a .unitypackage or .zip file.')
      ).toBeInTheDocument()
    );
    expect(screen.queryByText('leak.txt')).not.toBeInTheDocument();
    expect(forensicsApi.runCouplingForensicsLookup).not.toHaveBeenCalled();
  });

  it('rejects oversized uploads before starting a scan', async () => {
    listCreatorCertificatesMock.mockResolvedValue(createCertificatesOverview(true));

    render(<CouplingForensicsPanel />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const upload = new File(['placeholder'], 'huge.zip', { type: 'application/zip' });
    Object.defineProperty(upload, 'size', {
      value: 100 * 1024 * 1024 + 1,
    });

    fireEvent.change(fileInput, { target: { files: [upload] } });

    await waitFor(() =>
      expect(screen.getByText('File is too large. Maximum size is 100 MB.')).toBeInTheDocument()
    );
    expect(screen.queryByText('huge.zip')).not.toBeInTheDocument();
    expect(forensicsApi.runCouplingForensicsLookup).not.toHaveBeenCalled();
  });

  it('does not claim tracking removal when the decoder finds no signal', async () => {
    runCouplingForensicsLookupMock.mockResolvedValue({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'no_signal_found',
      message: 'No valid coupling signal was found.',
      candidateAssetCount: 1,
      decodedAssetCount: 0,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          decoderKind: 'png',
          matched: false,
          layerBClassification: 'no-signal-found',
          matches: [],
        },
      ],
    } as never);

    render(<CouplingForensicsPanel />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    fireEvent.change(fileInput, {
      target: {
        files: [new File(['archive'], 'uncoupled.zip', { type: 'application/zip' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /find buyer/i }));

    await waitFor(() => expect(screen.getByText('No tracking signal found')).toBeInTheDocument());
    expect(screen.queryByText('Tracking removed')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'The file has no valid buyer signal. It can be an original file, an older release, or a modified copy.'
      )
    ).toBeInTheDocument();
  });

  it('clears the prior verdict when the creator selects a different file', async () => {
    runCouplingForensicsLookupMock.mockResolvedValue({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'attributed',
      message: 'Authorized matches found',
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          decoderKind: 'png',
          tokenLength: 64,
          matched: true,
          matches: [
            {
              matchId: 'match-buyer-one',
              buyerMatchId: 'buyer-license-one',
              assetPath: 'Assets/Character/body.png',
              createdAt: 1_744_317_600_000,
              runtimeArtifactVersion: 'coupling-server-v3',
              provider: 'jinxxy',
              buyerSubjectDisplayName: 'Buyer One',
            },
          ],
        },
      ],
    });

    render(<CouplingForensicsPanel />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const firstInput = document.getElementById('forensics-file');
    if (!(firstInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }
    fireEvent.change(firstInput, {
      target: {
        files: [new File(['first'], 'first.zip', { type: 'application/zip' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /find buyer/i }));

    await waitFor(() => expect(screen.getByText('Buyer identified')).toBeInTheDocument());
    const selectedInput = document.getElementById('forensics-file');
    if (!(selectedInput instanceof HTMLInputElement)) {
      throw new Error('Selected-state forensics file input was not rendered');
    }
    fireEvent.change(selectedInput, {
      target: {
        files: [new File(['second'], 'second.zip', { type: 'application/zip' })],
      },
    });

    expect(screen.getByText('second.zip')).toBeInTheDocument();
    expect(screen.queryByText('Buyer identified')).not.toBeInTheDocument();
    expect(screen.queryByText('Buyer One')).not.toBeInTheDocument();
  });

  it('surfaces an unresolved trace state when a trace matches but no buyer identity is available', async () => {
    runCouplingForensicsLookupMock.mockResolvedValue({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'attributed',
      message: 'Authorized matches found',
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          decoderKind: 'png',
          tokenLength: 64,
          matched: true,
          matches: [
            {
              matchId: 'match-unresolved',
              assetPath: 'Assets/Character/body.png',
              createdAt: 1_744_317_600_000,
              runtimeArtifactVersion: 'sha256-b8c6ba93829b',
              provider: 'jinxxy',
            },
          ],
        },
      ],
    });

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const upload = new File(['archive'], 'leak.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [upload] } });

    await waitFor(() => expect(screen.getByText('leak.zip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /find buyer/i }));

    await waitFor(() => expect(screen.getByText('Trace found')).toBeInTheDocument());

    expect(screen.queryByText('Buyer identified')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "This file matches a traced license in your store, but we don't have the original buyer linked to that license yet."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('License key hash (SHA-256)')).not.toBeInTheDocument();
    expect(screen.queryByText('Grant ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Trace recorded')).not.toBeInTheDocument();
  });

  it('renders provider-native buyer identity when no purchaser email is available', async () => {
    runCouplingForensicsLookupMock.mockResolvedValue({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'attributed',
      message: 'Authorized matches found',
      candidateAssetCount: 1,
      decodedAssetCount: 1,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          decoderKind: 'png',
          tokenLength: 64,
          matched: true,
          matches: [
            {
              matchId: 'match-buyer-one',
              buyerMatchId: 'buyer-license-one',
              assetPath: 'Assets/Character/body.png',
              createdAt: 1_744_317_600_000,
              runtimeArtifactVersion: 'sha256-b8c6ba93829b',
              provider: 'jinxxy',
              buyerProviderUsername: 'BuyerAccount',
              buyerSubjectDisplayName: 'Buyer One',
              licenseMasked: 'jinxxy:abcd1234',
            },
          ],
        },
      ],
    });

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const upload = new File(['archive'], 'leak.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [upload] } });

    await waitFor(() => expect(screen.getByText('leak.zip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /find buyer/i }));

    await waitFor(() => expect(screen.getByText('Buyer identified')).toBeInTheDocument());

    expect(screen.getByText('Buyer One')).toBeInTheDocument();
    expect(screen.getByText('BuyerAccount')).toBeInTheDocument();
    expect(screen.getByText('jinxxy:abcd1234')).toBeInTheDocument();
    expect(screen.queryByText('sha256-b8c6ba93829b')).not.toBeInTheDocument();
    expect(screen.queryByText('Package version')).not.toBeInTheDocument();
    expect(screen.queryByText('customer-123')).not.toBeInTheDocument();
    expect(screen.queryByText('test-placeholder-forensics-license-key')).not.toBeInTheDocument();
  });

  it('deduplicates buyer cards across multiple asset matches for the same buyer', async () => {
    runCouplingForensicsLookupMock.mockResolvedValue({
      packageId: 'pkg.creator.bundle',
      lookupStatus: 'attributed',
      message: 'Authorized matches found',
      candidateAssetCount: 2,
      decodedAssetCount: 2,
      results: [
        {
          assetPath: 'Assets/Character/body.png',
          assetType: 'png',
          decoderKind: 'png',
          tokenLength: 64,
          matched: true,
          matches: [
            {
              matchId: 'match-body',
              buyerMatchId: 'buyer-license-one',
              assetPath: 'Assets/Character/body.png',
              createdAt: 1_744_317_600_000,
              runtimeArtifactVersion: 'sha256-b8c6ba93829b',
              provider: 'jinxxy',
              buyerSubjectDisplayName: 'Buyer One',
              licenseMasked: 'jinxxy:abcd1234',
            },
          ],
        },
        {
          assetPath: 'Assets/Character/head.png',
          assetType: 'png',
          decoderKind: 'png',
          tokenLength: 64,
          matched: true,
          matches: [
            {
              matchId: 'match-head',
              buyerMatchId: 'buyer-license-one',
              assetPath: 'Assets/Character/head.png',
              createdAt: 1_744_317_700_000,
              runtimeArtifactVersion: 'sha256-b8c6ba93829b',
              provider: 'jinxxy',
              buyerSubjectDisplayName: 'Buyer One',
              licenseMasked: 'jinxxy:abcd1234',
            },
          ],
        },
      ],
    });

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(document.getElementById('forensics-file')).toBeInstanceOf(HTMLInputElement)
    );
    const fileInput = document.getElementById('forensics-file');
    if (!(fileInput instanceof HTMLInputElement)) {
      throw new Error('Forensics file input was not rendered');
    }

    const upload = new File(['archive'], 'leak.zip', { type: 'application/zip' });
    fireEvent.change(fileInput, { target: { files: [upload] } });

    await waitFor(() => expect(screen.getByText('leak.zip')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /find buyer/i }));

    await waitFor(() => expect(screen.getByText('Buyer identified')).toBeInTheDocument());

    expect(screen.queryByText('2 buyers identified')).not.toBeInTheDocument();
    expect(screen.getAllByText('Buyer One')).toHaveLength(1);
  });

  it('renders the human package name instead of a raw package id in the selector', async () => {
    listCreatorCertificatesMock.mockResolvedValue(createCertificatesOverview(true));

    const Component = CouplingForensicsPanel;
    if (!Component) {
      throw new Error('Forensics route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Creator Bundle')).toBeInTheDocument());
    expect(screen.queryByText('pkg.creator.bundle')).not.toBeInTheDocument();
  });
});
