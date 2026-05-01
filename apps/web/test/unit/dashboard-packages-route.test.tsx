import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { BILLING_CAPABILITY_KEYS } from '../../../../convex/lib/billingCapabilities';

type MockLinkProps = ComponentPropsWithoutRef<'a'> & {
  children?: ReactNode;
  search?: unknown;
  to?: unknown;
};

async function findMoreToolsTrigger() {
  const [trigger] = await screen.findAllByText(/^More tools$/);
  if (!trigger) {
    throw new Error('More tools trigger not found');
  }
  return trigger as HTMLElement;
}

async function openMoreTools() {
  fireEvent.click(await findMoreToolsTrigger());
}

async function findExactTextNode(value: string) {
  const [match] = await screen.findAllByText((_content, element) => {
    const textContent = element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (!textContent.includes(value)) {
      return false;
    }
    return Array.from(element?.children ?? []).every((child) => {
      const childText = child.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return !childText.includes(value);
    });
  });
  if (!match) {
    throw new Error(`Text node not found: ${value}`);
  }
  return match;
}

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, search: _search, to: _to, ...props }: MockLinkProps) => (
    <a {...props}>{children}</a>
  ),
  createFileRoute: () => (options: unknown) => ({ options }),
  createLazyFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock('@heroui/react', () => {
  const HOLD_CONFIRM_MARKER = Symbol.for('hold-confirm');
  const AutocompleteContext = createContext<{
    placeholder?: string;
    searchValue: string;
    selectedText: string | null;
    setSearchValue: (value: string) => void;
    selectItem: (key: string, text: string) => void;
    clear: () => void;
  } | null>(null);

  function findHoldConfirmCallback(children: ReactNode): (() => void) | undefined {
    let callback: (() => void) | undefined;
    Children.forEach(children, (child) => {
      if (callback || !isValidElement(child)) {
        return;
      }

      const elementType = child.type as { [HOLD_CONFIRM_MARKER]?: boolean } | string;
      if (typeof elementType !== 'string' && elementType[HOLD_CONFIRM_MARKER]) {
        const onComplete = (child.props as { onComplete?: () => void }).onComplete;
        if (typeof onComplete === 'function') {
          callback = onComplete;
        }
        return;
      }

      callback = findHoldConfirmCallback((child.props as { children?: ReactNode }).children);
    });
    return callback;
  }

  function getNodeText(children: ReactNode): string {
    return Children.toArray(children)
      .map((child) => {
        if (typeof child === 'string' || typeof child === 'number') {
          return String(child);
        }

        if (!isValidElement(child)) {
          return '';
        }

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
    selectedKey: _selectedKey,
    textValue: _textValue,
    onSelectionChange: _onSelectionChange,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;

  const Button = ({
    children,
    isDisabled,
    isIconOnly: _isIconOnly,
    onPress,
    type = 'button',
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <button
      type={typeof type === 'string' ? type : 'button'}
      disabled={Boolean(isDisabled)}
      onClick={() => {
        if (typeof onPress === 'function') {
          onPress();
        }

        if (isDisabled) {
          return;
        }

        findHoldConfirmCallback(children)?.();
      }}
      {...props}
    >
      {children}
    </button>
  );

  const Input = ({
    children: _children,
    isDisabled,
    disabled,
    onChange,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <input disabled={Boolean(isDisabled ?? disabled)} onChange={onChange as never} {...props} />
  );

  const TextArea = ({
    children,
    isDisabled,
    disabled,
    onChange,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <textarea disabled={Boolean(isDisabled ?? disabled)} onChange={onChange as never} {...props}>
      {typeof children === 'string' ? children : undefined}
    </textarea>
  );

  const Chip = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );

  const Label = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );

  const Description = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <span {...props}>{children}</span>
  );

  const Card = Object.assign(Div, {
    Header: Div,
    Content: Div,
    Footer: Div,
  });

  const ListBox = Object.assign(
    ({
      children,
      renderEmptyState,
      ...props
    }: PropsWithChildren<Record<string, unknown> & { renderEmptyState?: () => ReactNode }>) => {
      const autocomplete = useContext(AutocompleteContext);
      const items = Children.toArray(children).filter((child) => child !== null);
      const visibleItems = autocomplete
        ? items.filter((child) => {
            if (!isValidElement(child)) {
              return true;
            }

            const textValue = String(
              (child.props as { textValue?: string }).textValue ??
                getNodeText((child.props as { children?: ReactNode }).children)
            ).toLowerCase();

            return textValue.includes(autocomplete.searchValue.toLowerCase());
          })
        : items;

      if (visibleItems.length === 0 && typeof renderEmptyState === 'function') {
        return <div {...props}>{renderEmptyState()}</div>;
      }

      return <div {...props}>{visibleItems}</div>;
    },
    {
      Item: ({
        children,
        id,
        textValue: _textValue,
        ...props
      }: PropsWithChildren<Record<string, unknown> & { id?: string; textValue?: string }>) => {
        const autocomplete = useContext(AutocompleteContext);

        if (!autocomplete) {
          return <div {...props}>{children}</div>;
        }

        const label = getNodeText(children);
        return (
          <button
            type="button"
            onClick={() => autocomplete.selectItem(String(id ?? label), label)}
            {...props}
          >
            {children}
          </button>
        );
      },
      ItemIndicator: Div,
      Section: Div,
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
              if (typeof onChange === 'function') {
                onChange(key);
              }
            },
            clear: () => {
              setSelectedText(null);
              setSearchValue('');
              if (typeof onClear === 'function') {
                onClear();
              }
              if (typeof onChange === 'function') {
                onChange(null);
              }
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
      Value: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const autocomplete = useContext(AutocompleteContext);

        return (
          <div {...props}>
            {typeof children === 'function'
              ? children({
                  defaultChildren: autocomplete?.placeholder ?? null,
                  isPlaceholder: !autocomplete?.selectedText,
                  state: { selectedItems: [] },
                })
              : (autocomplete?.selectedText ?? autocomplete?.placeholder ?? null)}
          </div>
        );
      },
      ClearButton: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const autocomplete = useContext(AutocompleteContext);

        return (
          <button type="button" onClick={() => autocomplete?.clear()} {...props}>
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

  const Select = Object.assign(Div, {
    Trigger: Div,
    Value: Div,
    Indicator: Div,
    Popover: Div,
  });

  const Radio = Object.assign(Div, {
    Control: Div,
    Indicator: Div,
    Content: Div,
  });

  const RadioGroup = Div;

  const Checkbox = Object.assign(Div, {
    Control: Div,
    Indicator: Div,
    Content: Div,
  });

  const CheckboxGroup = Div;

  const Skeleton = ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  );

  const SearchField = Object.assign(
    ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
      <div {...props}>{children}</div>
    ),
    {
      Group: Div,
      SearchIcon: Div,
      ClearButton: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const autocomplete = useContext(AutocompleteContext);

        return (
          <button type="button" onClick={() => autocomplete?.setSearchValue('')} {...props}>
            {children}
          </button>
        );
      },
      Input: ({ onChange, ...props }: PropsWithChildren<Record<string, unknown>>) => {
        const autocomplete = useContext(AutocompleteContext);

        return (
          <input
            value={autocomplete?.searchValue ?? ''}
            onChange={(event) => {
              autocomplete?.setSearchValue(event.target.value);
              if (typeof onChange === 'function') {
                onChange(event);
              }
            }}
            {...props}
          />
        );
      },
    }
  );

  const Spinner = ({ ...props }: Record<string, unknown>) => <div {...props} />;

  const Tooltip = Object.assign(({ children }: PropsWithChildren) => <>{children}</>, {
    Content: Div,
  });

  return {
    Autocomplete,
    Button,
    Card,
    Checkbox,
    CheckboxGroup,
    Chip,
    Description,
    Label,
    ListBox,
    Radio,
    RadioGroup,
    SearchField,
    Select,
    Skeleton,
    Spinner,
    TextArea,
    Tooltip,
    Input,
    useFilter: () => ({
      contains: (text: string, inputValue: string) =>
        text.toLowerCase().includes(inputValue.toLowerCase()),
    }),
  };
});

vi.mock('@/components/ui/Toast', () => ({
  useToast: vi.fn(() => ({
    error: vi.fn(),
    success: vi.fn(),
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
  useDashboardSession: vi.fn(() => ({
    canRunPanelQueries: true,
    isAuthResolved: true,
    markSessionExpired: vi.fn(),
    status: 'active',
  })),
  isDashboardAuthError: vi.fn(() => false),
}));

vi.mock('@heroui-pro/react', () => {
  const HOLD_CONFIRM_MARKER = Symbol.for('hold-confirm');
  const Div = ({
    children,
    isDisabled: _isDisabled,
    isOpen: _isOpen,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;
  const Input = ({
    children: _children,
    isDisabled: _isDisabled,
    onSelect,
    onOpenChange: _onOpenChange,
    onPress: _onPress,
    ...props
  }: PropsWithChildren<Record<string, unknown>>) => (
    <input
      {...props}
      onChange={(event) => {
        if (typeof onSelect === 'function') {
          onSelect((event.target as HTMLInputElement).files);
        }
      }}
    />
  );

  const DropZone = Object.assign(Div, {
    Area: Div,
    Description: Div,
    FileFormatIcon: Div,
    FileInfo: Div,
    FileItem: Div,
    FileList: Div,
    FileMeta: Div,
    FileName: Div,
    FileProgress: Div,
    FileProgressFill: Div,
    FileProgressTrack: Div,
    FileRemoveTrigger: Div,
    Icon: Div,
    Input,
    Label: Div,
    Trigger: Div,
  });

  const EmptyState = Object.assign(Div, {
    Content: Div,
    Description: Div,
    Header: Div,
    Media: Div,
    Title: Div,
  });

  const ItemCard = Object.assign(Div, {
    Action: Div,
    Content: Div,
    Description: Div,
    Icon: Div,
    Title: Div,
  });

  const Sheet = Object.assign(Div, {
    Backdrop: Div,
    Body: Div,
    Close: Div,
    CloseTrigger: Div,
    Content: Div,
    Dialog: Div,
    Footer: Div,
    Handle: Div,
    Header: Div,
    Heading: Div,
  });

  const HoldConfirm = Object.assign(
    ({
      children,
      isDisabled: _isDisabled,
      onComplete: _onComplete,
      duration: _duration,
      releaseDuration: _releaseDuration,
      sweep: _sweep,
      resetOnComplete: _resetOnComplete,
      ...props
    }: PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>,
    { [HOLD_CONFIRM_MARKER]: true }
  );

  return {
    DropZone,
    EmptyState,
    ItemCard,
    PressableFeedback: {
      HoldConfirm,
    },
    Sheet,
  };
});

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

vi.mock('@/lib/packages', () => ({
  archiveCreatorPackage: vi.fn(),
  archiveCreatorBackstageRelease: vi.fn(),
  archiveCreatorBackstageProduct: vi.fn(),
  deleteCreatorBackstageRelease: vi.fn(),
  listCreatorBackstageProducts: vi.fn(),
  listCreatorPackages: vi.fn(),
  publishBackstageRelease: vi.fn(),
  renameCreatorPackage: vi.fn(),
  requestBackstageRepoAccess: vi.fn(),
  restoreCreatorBackstageProduct: vi.fn(),
  restoreCreatorPackage: vi.fn(),
  uploadBackstageReleaseFileDirect: vi.fn(),
}));

import { buildProductLanes } from '@/components/dashboard/PackageRegistryPanel';
import * as certificateApi from '@/lib/certificates';
import * as packagesApi from '@/lib/packages';
import { Route as PackagesRoute } from '@/routes/_authenticated/dashboard/packages.lazy';

const listCreatorCertificatesMock = certificateApi.listCreatorCertificates as ReturnType<
  typeof vi.fn
>;
const listCreatorBackstageProductsMock = packagesApi.listCreatorBackstageProducts as ReturnType<
  typeof vi.fn
>;
const listCreatorPackagesMock = packagesApi.listCreatorPackages as ReturnType<typeof vi.fn>;
const renameCreatorPackageMock = packagesApi.renameCreatorPackage as ReturnType<typeof vi.fn>;
const archiveCreatorBackstageReleaseMock = packagesApi.archiveCreatorBackstageRelease as ReturnType<
  typeof vi.fn
>;
const deleteCreatorBackstageReleaseMock = packagesApi.deleteCreatorBackstageRelease as ReturnType<
  typeof vi.fn
>;
const archiveCreatorBackstageProductMock = packagesApi.archiveCreatorBackstageProduct as ReturnType<
  typeof vi.fn
>;
const publishBackstageReleaseMock = packagesApi.publishBackstageRelease as ReturnType<typeof vi.fn>;
const requestBackstageRepoAccessMock = packagesApi.requestBackstageRepoAccess as ReturnType<
  typeof vi.fn
>;
const uploadBackstageReleaseFileDirectMock = packagesApi.uploadBackstageReleaseFileDirect as ReturnType<
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

describe('dashboard packages route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCreatorCertificatesMock.mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'active',
        allowEnrollment: true,
        allowSigning: true,
        planKey: 'creator-suite',
        productId: 'prod_creator_suite',
        deviceCap: 5,
        activeDeviceCount: 1,
        signQuotaPerPeriod: null,
        auditRetentionDays: 90,
        supportTier: 'premium',
        currentPeriodEnd: null,
        graceUntil: null,
        reason: null,
        capabilities: [
          {
            capabilityKey: BILLING_CAPABILITY_KEYS.vpmRepo,
            status: 'active',
          },
        ],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    });
    listCreatorPackagesMock.mockResolvedValue({
      packages: [
        {
          packageId: 'pkg.creator.bundle',
          packageName: 'Creator Bundle',
          registeredAt: 1_710_000_000_000,
          updatedAt: 1_710_000_100_000,
          status: 'active',
          archivedAt: undefined,
          canDelete: false,
          deleteBlockedReason: 'Package has signing or license history and cannot be deleted.',
          canArchive: true,
          canRestore: false,
        },
        {
          packageId: 'pkg.creator.legacy',
          packageName: 'Legacy Bundle',
          registeredAt: 1_709_000_000_000,
          updatedAt: 1_709_000_100_000,
          status: 'archived',
          archivedAt: 1_710_500_000_000,
          canDelete: false,
          deleteBlockedReason: 'Archived packages keep their audit history.',
          canArchive: false,
          canRestore: true,
        },
      ],
    });
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['Creator Bundle Product'],
          catalogTiers: [
            {
              catalogTierId: 'tier_gold',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef:
                'gumroad|product|17:gumroad-product-1|variant|4:tier|option|4:gold|recurrence|7:monthly',
              displayName: 'Gold Monthly',
              description: 'Monthly supporter tier',
              amountCents: 1200,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
            {
              catalogTierId: 'tier_platinum',
              catalogProductId: 'product_1',
              provider: 'gumroad',
              providerTierRef:
                'gumroad|product|17:gumroad-product-1|variant|8:platinum|recurrence|7:monthly',
              displayName: 'Platinum Monthly',
              description: 'Higher supporter tier',
              amountCents: 2400,
              currency: 'USD',
              status: 'active',
              createdAt: 1_710_000_000_000,
              updatedAt: 1_710_000_000_000,
            },
          ],
          backstagePackages: [
            {
              packageId: 'pkg.creator.bundle',
              packageName: 'Creator Bundle',
              displayName: 'Creator Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'creator-bundle-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'release_current',
                  version: '1.2.3',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:creator-bundle',
                  contentType: 'application/zip',
                  createdAt: 1_710_000_000_000,
                  deliveryName: 'creator-bundle-1.2.3.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_100_000,
                  zipSha256: 'a'.repeat(64),
                },
                {
                  deliveryPackageReleaseId: 'release_old',
                  version: '1.2.2',
                  channel: 'stable',
                  releaseStatus: 'superseded',
                  repositoryVisibility: 'hidden',
                  artifactKey: 'artifact:creator-bundle-older',
                  contentType: 'application/zip',
                  createdAt: 1_709_000_000_000,
                  deliveryName: 'creator-bundle-1.2.2.zip',
                  metadata: { source: 'zip' },
                  publishedAt: 1_709_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_709_000_100_000,
                  zipSha256: 'b'.repeat(64),
                },
              ],
            },
          ],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_1',
          displayName: 'Creator Bundle Product',
          thumbnailUrl: 'https://public-files.gumroad.com/creator-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package, role, entitlement, or tier history.',
        },
        {
          aliases: ['Creator Bundle Product'],
          catalogTiers: [],
          backstagePackages: [],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_2',
          displayName: 'Creator Bundle Product',
          productId: 'jinxxy-product-1',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
        {
          aliases: ['Old Creator Product'],
          catalogTiers: [],
          backstagePackages: [],
          canonicalSlug: 'old-creator-product',
          catalogProductId: 'product_hidden',
          displayName: 'Old Creator Product',
          productId: 'gumroad-product-hidden',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-hidden',
          status: 'archived',
          supportsAutoDiscovery: true,
          updatedAt: 1_709_000_100_000,
          canArchive: false,
          canRestore: true,
          canDelete: true,
        },
      ],
    });
    requestBackstageRepoAccessMock.mockResolvedValue({
      creatorName: 'Mapache',
      creatorRepoRef: 'mapache',
      repositoryUrl: 'https://api.test/v1/backstage/repos/mapache/index.json',
      repositoryName: 'Mapache repo',
      addRepoUrl:
        'vcc://vpm/addRepo?url=https%3A%2F%2Fapi.test%2Fv1%2Fbackstage%2Frepos%2Fmapache%2Findex.json',
      expiresAt: 1_710_000_100_000,
    });
    uploadBackstageReleaseFileDirectMock.mockResolvedValue({
      cdngineSource: {
        assetId: 'ast_uploaded_1',
        assetOwner: 'creator:auth-user-1',
        byteSize: 128,
        serviceNamespaceId: 'yucp-backstage',
        sha256: 'f'.repeat(64),
        tenantId: 'auth-user-1',
        uploadedAt: 1_710_000_000_000,
        versionId: 'ver_uploaded_1',
      },
      deliveryName: 'bundle.unitypackage',
      sourceContentType: 'application/octet-stream',
    });
    publishBackstageReleaseMock.mockResolvedValue({
      deliveryPackageReleaseId: 'release_new',
      zipSha256: 'f'.repeat(64),
      version: '1.2.3',
      channel: 'stable',
    });
    renameCreatorPackageMock.mockResolvedValue({
      updated: true,
      packageId: 'pkg.creator.bundle',
      packageName: 'Creator Bundle+',
    });
    archiveCreatorBackstageProductMock.mockResolvedValue({
      archived: true,
      catalogProductId: 'product_1',
    });
    archiveCreatorBackstageReleaseMock.mockResolvedValue({
      archived: true,
      deliveryPackageReleaseId: 'release_old',
    });
    deleteCreatorBackstageReleaseMock.mockResolvedValue({
      deleted: true,
      deliveryPackageReleaseId: 'release_old',
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders repo access and product-linked release lanes', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/Share your YUCP access page link/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy store-page link/i }).length).toBeGreaterThan(
      0
    );
    expect(screen.getAllByText('Creator Bundle Product').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^upload$/i }).length).toBeGreaterThan(0);
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).not.toBeNull();
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/creator-bundle.png"]')
    ).toHaveAttribute('src', 'https://public-files.gumroad.com/creator-bundle.png');
  });

  it('keeps repo testing guidance under collapsed more tools copy', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );

    await openMoreTools();

    expect(screen.getByText(/testing and support repo tools/i)).toBeInTheDocument();
    expect(screen.getByText(/not for customer-facing distribution/i)).toBeInTheDocument();
    expect(screen.getByText(/Mapache/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open test repo in vcc/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy test vcc link/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy raw repo url/i })).toBeInTheDocument();
  });

  it('aggregates active subscription tiers into a product lane for package setup', () => {
    const lanes = buildProductLanes([
      {
        aliases: ['Creator Bundle Product'],
        catalogTiers: [
          {
            catalogTierId: 'tier_gold',
            catalogProductId: 'product_1',
            provider: 'gumroad',
            providerTierRef: 'gumroad-tier-gold',
            displayName: 'Gold Monthly',
            description: 'Monthly supporter tier',
            amountCents: 1200,
            currency: 'USD',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
          {
            catalogTierId: 'tier_legacy',
            catalogProductId: 'product_1',
            provider: 'gumroad',
            providerTierRef: 'gumroad-tier-legacy',
            displayName: 'Legacy Tier',
            status: 'archived',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        backstagePackages: [],
        canonicalSlug: 'creator-bundle',
        catalogProductId: 'product_1',
        displayName: 'Creator Bundle Product',
        productId: 'gumroad-product-1',
        provider: 'gumroad',
        providerProductRef: 'gumroad-product-1',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1,
        canArchive: true,
        canRestore: false,
        canDelete: false,
      },
      {
        aliases: ['Creator Bundle Product'],
        catalogTiers: [
          {
            catalogTierId: 'tier_platinum',
            catalogProductId: 'product_2',
            provider: 'patreon',
            providerTierRef: 'patreon-tier-platinum',
            displayName: 'Platinum Monthly',
            description: 'Higher supporter tier',
            amountCents: 2400,
            currency: 'USD',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        backstagePackages: [],
        canonicalSlug: 'creator-bundle',
        catalogProductId: 'product_2',
        displayName: 'Creator Bundle Product',
        productId: 'patreon-campaign-1',
        provider: 'patreon',
        providerProductRef: 'patreon-campaign-1',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ]);

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.catalogTiers.map((tier) => tier.catalogTierId)).toEqual([
      'tier_gold',
      'tier_platinum',
    ]);
  });

  it('treats a package with no uploads as needing first setup again', () => {
    const lanes = buildProductLanes([
      {
        aliases: ['Creator Bundle Product'],
        backstagePackages: [
          {
            packageId: 'pkg.creator.bundle',
            packageName: 'Creator Bundle',
            displayName: 'Creator Bundle',
            status: 'active',
            repositoryVisibility: 'listed',
            defaultChannel: 'stable',
            latestPublishedVersion: undefined,
            latestRelease: null,
            releases: [],
          },
        ],
        canArchive: true,
        canDelete: false,
        canRestore: false,
        catalogProductId: 'product_1',
        catalogTiers: [],
        canonicalSlug: 'creator-bundle',
        displayName: 'Creator Bundle Product',
        productId: 'gumroad-product-1',
        provider: 'gumroad',
        providerProductRef: 'gumroad-product-1',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1,
      },
    ]);

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.packageLinks).toHaveLength(0);
    expect(lanes[0]?.primaryPackage).toBeNull();
  });

  it('does not show tier access controls when the selected product has no synced subscription tiers', async () => {
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['One-time Bundle'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          catalogProductId: 'product_onetime',
          catalogTiers: [],
          canonicalSlug: 'one-time-bundle',
          displayName: 'One-time Bundle',
          productId: 'gumroad-one-time',
          provider: 'gumroad',
          providerProductRef: 'gumroad-one-time',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /upload a package/i }));

    expect(screen.queryByText('Whole subscription product')).not.toBeInTheDocument();
    expect(screen.queryByText('Specific subscription tiers')).not.toBeInTheDocument();
  });

  it('filters upload products by typed search in the picker', async () => {
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['HeroUI MCP'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          catalogProductId: 'product_hero_ui_mcp',
          catalogTiers: [],
          canonicalSlug: 'heroui-mcp',
          displayName: 'HeroUI MCP',
          productId: 'gumroad-heroui-mcp',
          provider: 'gumroad',
          providerProductRef: 'gumroad-heroui-mcp',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_000_000,
        },
        {
          aliases: ['HeroUI MCP Pro'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          catalogProductId: 'product_hero_ui_mcp_pro',
          catalogTiers: [],
          canonicalSlug: 'heroui-mcp-pro',
          displayName: 'HeroUI MCP Pro',
          productId: 'jinxxy-heroui-mcp-pro',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-heroui-mcp-pro',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
        },
        {
          aliases: ['Starter Bundle'],
          backstagePackages: [],
          canArchive: true,
          canDelete: true,
          canRestore: false,
          catalogProductId: 'product_starter_bundle',
          catalogTiers: [],
          canonicalSlug: 'starter-bundle',
          displayName: 'Starter Bundle',
          productId: 'patreon-starter-bundle',
          provider: 'patreon',
          providerProductRef: 'patreon-starter-bundle',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_200_000,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /upload a package/i }));

    const searchInput = screen.getByPlaceholderText(/search products/i);

    expect(screen.getByText(/^HeroUI MCP$/)).toBeInTheDocument();
    expect(screen.getByText(/^HeroUI MCP Pro$/)).toBeInTheDocument();
    expect(screen.getByText(/^Starter Bundle$/)).toBeInTheDocument();

    fireEvent.change(searchInput, { target: { value: 'pro' } });

    expect(screen.queryByText(/^HeroUI MCP$/)).toBeNull();
    expect(screen.getByText(/^HeroUI MCP Pro$/)).toBeInTheDocument();
    expect(screen.queryByText(/^Starter Bundle$/)).toBeNull();

    fireEvent.click(screen.getByText(/^HeroUI MCP Pro$/));

    expect(screen.getByText(/This product needs its first install ID\./i)).toBeInTheDocument();
  });

  it('shows package metadata fields and dependency validation in the publish sheet', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /upload a package/i }));

    await waitFor(() => expect(document.getElementById('package-release-version')).not.toBeNull());

    const dependenciesInput = document.querySelector(
      'textarea[aria-label="Dependencies"]'
    ) as HTMLTextAreaElement | null;
    const fileInput = document.querySelector(
      'input[aria-label="Choose update file"]'
    ) as HTMLInputElement | null;

    if (!dependenciesInput || !fileInput) {
      throw new Error('Expected publish metadata inputs to render.');
    }
    expect(screen.getByText('Package metadata')).toBeInTheDocument();
    expect(screen.getByLabelText('Package description')).toBeInTheDocument();
    expect(screen.getByLabelText('Unity version')).toBeInTheDocument();

    fireEvent.change(dependenciesInput, {
      target: { value: 'not-a-valid-dependency-line' },
    });

    expect(
      screen.getByText('Dependency line 1 must use com.package.id@1.0.0 or com.package.id=1.0.0.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload package/i })).toBeDisabled();
  });

  it('keeps first-upload products behind the upload button instead of a separate setup section', async () => {
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['Creator Bundle Product'],
          backstagePackages: [
            {
              packageId: 'pkg.creator.bundle',
              packageName: 'Creator Bundle',
              displayName: 'Creator Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'creator-bundle-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'song_release_current',
                  version: '2.4.0',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:song-bundle',
                  contentType: 'application/zip',
                  createdAt: 1_710_000_000_000,
                  deliveryName: 'song-bundle-2.4.0.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_100_000,
                  zipSha256: 'c'.repeat(64),
                },
              ],
            },
          ],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_1',
          displayName: 'Creator Bundle Product',
          thumbnailUrl: 'https://public-files.gumroad.com/creator-bundle.png',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package history.',
        },
        {
          aliases: ['Song Thing'],
          backstagePackages: [],
          canonicalSlug: 'song-thing',
          catalogProductId: 'song_gumroad',
          displayName: 'Song Thing',
          thumbnailUrl: 'https://public-files.gumroad.com/song-thing.png',
          productId: 'gumroad-song-thing',
          provider: 'gumroad',
          providerProductRef: 'gumroad-song-thing',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_200_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
        {
          aliases: ['Song Thing'],
          backstagePackages: [],
          canonicalSlug: 'song-thing',
          catalogProductId: 'song_jinxxy',
          displayName: 'Song Thing',
          productId: 'jinxxy-song-thing',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-song-thing',
          status: 'active',
          supportsAutoDiscovery: false,
          updatedAt: 1_710_000_300_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /upload a package/i })).toBeInTheDocument()
    );
    expect(screen.queryByText('Set up a new product')).toBeNull();
    expect(screen.queryByText('Song Thing')).toBeNull();
  });

  it('merges storefront rows when linked package IDs match even if slugs and names drift', async () => {
    listCreatorBackstageProductsMock.mockResolvedValue({
      products: [
        {
          aliases: ['Song'],
          backstagePackages: [
            {
              packageId: 'pkg.song.bundle',
              packageName: 'Song Bundle',
              displayName: 'Song Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '2.4.0',
              latestRelease: {
                deliveryPackageReleaseId: 'song_release_current',
                version: '2.4.0',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:song-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'song-bundle-2.4.0.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'c'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'song_release_current',
                  version: '2.4.0',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:song-bundle',
                  contentType: 'application/zip',
                  createdAt: 1_710_000_000_000,
                  deliveryName: 'song-bundle-2.4.0.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_100_000,
                  zipSha256: 'c'.repeat(64),
                },
              ],
            },
          ],
          canonicalSlug: 'song-deluxe-gumroad',
          catalogProductId: 'song_gumroad',
          displayName: 'Song Deluxe',
          thumbnailUrl: 'https://public-files.gumroad.com/song-deluxe.png',
          productId: 'gumroad-song-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-song-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package history.',
        },
        {
          aliases: ['Song'],
          backstagePackages: [
            {
              packageId: 'pkg.song.bundle',
              packageName: 'Song Bundle',
              displayName: 'Song Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '2.4.0',
              latestRelease: {
                deliveryPackageReleaseId: 'song_release_current',
                version: '2.4.0',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:song-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'song-bundle-2.4.0.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'c'.repeat(64),
              },
              releases: [],
            },
          ],
          canonicalSlug: 'song-deluxe-jinxxy',
          catalogProductId: 'song_jinxxy',
          displayName: 'Song: Deluxe Edition',
          productId: 'jinxxy-song-1',
          provider: 'jinxxy',
          providerProductRef: 'jinxxy-song-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: true,
        },
      ],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(
        screen.getByText(/Install ID:\s*pkg\.song\.bundle\s+·\s+Live version 2\.4\.0/i)
      ).toBeInTheDocument()
    );
    expect(screen.getAllByText(/Song/i).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.pm-product-row')).toHaveLength(1);
    expect(
      document.querySelector('img[src="https://public-files.gumroad.com/song-deluxe.png"]')
    ).not.toBeNull();
  });

  it('does not merge storefront rows through shared aliases when alias ids differ', async () => {
    const lanes = buildProductLanes([
      {
        aliases: ['Song'],
        backstagePackages: [],
        canonicalSlug: 'gumroad-song-release',
        catalogProductId: 'song_alias_gumroad',
        displayName: 'Song Release',
        productId: 'gumroad-song-alias',
        provider: 'gumroad',
        providerProductRef: 'gumroad-song-alias',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
      {
        aliases: ['Song'],
        backstagePackages: [],
        canonicalSlug: 'patreon-song-membership',
        catalogProductId: 'song_alias_patreon',
        displayName: 'Song Members Tier',
        productId: 'patreon-song-alias',
        provider: 'patreon',
        providerProductRef: 'patreon-song-alias',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ]);

    expect(lanes).toHaveLength(2);
    expect(lanes[0]?.products).toHaveLength(1);
    expect(lanes[1]?.products).toHaveLength(1);
  });

  it('merges storefront rows when the shared display identity matches after provider-specific slugs diverge', () => {
    const lanes = buildProductLanes([
      {
        aliases: [],
        backstagePackages: [],
        canonicalSlug: 'gumroad-songthing',
        catalogProductId: 'song_display_gumroad',
        displayName: 'Song Thing',
        productId: 'gumroad-song-display',
        provider: 'gumroad',
        providerProductRef: 'gumroad-songthing',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
      {
        aliases: [],
        backstagePackages: [],
        canonicalSlug: 'jinxxy-song-thing',
        catalogProductId: 'song_display_jinxxy',
        displayName: 'Song Thing',
        productId: 'jinxxy-song-display',
        provider: 'jinxxy',
        providerProductRef: 'jinxxy-song-thing',
        status: 'active',
        supportsAutoDiscovery: true,
        updatedAt: 1_710_000_100_000,
        canArchive: true,
        canRestore: false,
        canDelete: true,
      },
    ]);

    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.products).toHaveLength(2);
  });

  it('shows the Polar upgrade gate when the custom VPM repo entitlement is missing', async () => {
    listCreatorCertificatesMock.mockResolvedValue({
      workspaceKey: 'creator-profile:profile-1',
      creatorProfileId: 'profile-1',
      billing: {
        billingEnabled: true,
        status: 'inactive',
        allowEnrollment: false,
        allowSigning: false,
        planKey: null,
        productId: null,
        deviceCap: null,
        activeDeviceCount: 0,
        signQuotaPerPeriod: null,
        auditRetentionDays: null,
        supportTier: null,
        currentPeriodEnd: null,
        graceUntil: null,
        reason: 'Certificate subscription required',
        capabilities: [],
      },
      devices: [],
      availablePlans: [],
      meters: [],
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Custom VPM repo required')).toBeInTheDocument());
    expect(screen.getByText('Upgrade billing')).toBeInTheDocument();
    expect(listCreatorPackagesMock).not.toHaveBeenCalled();
  });

  it('opens a product link and shows previous uploads', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    expect(screen.getByText('Past uploads')).toBeInTheDocument();
    expect(screen.getByText('creator-bundle-1.2.3.zip')).toBeInTheDocument();
    expect(screen.getByText('creator-bundle-1.2.2.zip')).toBeInTheDocument();
    expect(screen.getByText(/SHA-256 a{64}/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy install id/i }).length).toBeGreaterThan(0);
  });

  it('archives an old upload from the past uploads sheet', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    fireEvent.click(screen.getByRole('button', { name: /archive upload/i }));

    await waitFor(() =>
      expect(archiveCreatorBackstageReleaseMock).toHaveBeenCalledWith({
        packageId: 'pkg.creator.bundle',
        deliveryPackageReleaseId: 'release_old',
      })
    );
  });

  it('deletes an old upload from the past uploads sheet after confirmation', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    const deleteButtons = screen.getAllByRole('button', { name: /hold to delete upload/i });
    const oldUploadDeleteButton = deleteButtons[deleteButtons.length - 1];
    if (!oldUploadDeleteButton) {
      throw new Error('Old upload delete button not found');
    }
    fireEvent.click(oldUploadDeleteButton);

    await waitFor(() =>
      expect(deleteCreatorBackstageReleaseMock).toHaveBeenCalledWith({
        packageId: 'pkg.creator.bundle',
        deliveryPackageReleaseId: 'release_old',
      })
    );
  });

  it('lets creators delete the last upload and returns the lane to first-upload setup', async () => {
    let currentProductState: Awaited<ReturnType<typeof listCreatorBackstageProductsMock>> = {
      products: [
        {
          aliases: ['Creator Bundle Product'],
          catalogTiers: [],
          backstagePackages: [
            {
              packageId: 'pkg.creator.bundle',
              packageName: 'Creator Bundle',
              displayName: 'Creator Bundle',
              status: 'active',
              repositoryVisibility: 'listed',
              defaultChannel: 'stable',
              latestPublishedVersion: '1.2.3',
              latestRelease: {
                deliveryPackageReleaseId: 'release_current',
                version: '1.2.3',
                channel: 'stable',
                releaseStatus: 'published',
                repositoryVisibility: 'listed',
                artifactKey: 'artifact:creator-bundle',
                contentType: 'application/zip',
                createdAt: 1_710_000_000_000,
                deliveryName: 'creator-bundle-1.2.3.zip',
                metadata: { source: 'unitypackage' },
                publishedAt: 1_710_000_100_000,
                unityVersion: '2022.3',
                updatedAt: 1_710_000_100_000,
                zipSha256: 'a'.repeat(64),
              },
              releases: [
                {
                  deliveryPackageReleaseId: 'release_current',
                  version: '1.2.3',
                  channel: 'stable',
                  releaseStatus: 'published',
                  repositoryVisibility: 'listed',
                  artifactKey: 'artifact:creator-bundle',
                  contentType: 'application/zip',
                  createdAt: 1_710_000_000_000,
                  deliveryName: 'creator-bundle-1.2.3.zip',
                  metadata: { source: 'unitypackage' },
                  publishedAt: 1_710_000_100_000,
                  unityVersion: '2022.3',
                  updatedAt: 1_710_000_100_000,
                  zipSha256: 'a'.repeat(64),
                },
              ],
            },
          ],
          canonicalSlug: 'creator-bundle',
          catalogProductId: 'product_1',
          displayName: 'Creator Bundle Product',
          productId: 'gumroad-product-1',
          provider: 'gumroad',
          providerProductRef: 'gumroad-product-1',
          status: 'active',
          supportsAutoDiscovery: true,
          updatedAt: 1_710_000_100_000,
          canArchive: true,
          canRestore: false,
          canDelete: false,
          deleteBlockedReason: 'Product has package, role, entitlement, or tier history.',
        },
      ],
    };
    listCreatorBackstageProductsMock.mockImplementation(async () => currentProductState);
    deleteCreatorBackstageReleaseMock.mockImplementation(async ({ deliveryPackageReleaseId }) => {
      if (deliveryPackageReleaseId === 'release_current') {
        currentProductState = {
          products: [
            {
              aliases: ['Creator Bundle Product'],
              catalogTiers: [],
              backstagePackages: [
                {
                  packageId: 'pkg.creator.bundle',
                  packageName: 'Creator Bundle',
                  displayName: 'Creator Bundle',
                  status: 'active',
                  repositoryVisibility: 'hidden',
                  defaultChannel: 'stable',
                  latestPublishedVersion: undefined,
                  latestRelease: null,
                  releases: [],
                },
              ],
              canonicalSlug: 'creator-bundle',
              catalogProductId: 'product_1',
              displayName: 'Creator Bundle Product',
              productId: 'gumroad-product-1',
              provider: 'gumroad',
              providerProductRef: 'gumroad-product-1',
              status: 'active',
              supportsAutoDiscovery: true,
              updatedAt: 1_710_000_200_000,
              canArchive: true,
              canRestore: false,
              canDelete: false,
              deleteBlockedReason: 'Product has package, role, entitlement, or tier history.',
            },
          ],
        };
      }

      return {
        deleted: true,
        deliveryPackageReleaseId,
      };
    });

    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/Install ID:\s*pkg\.creator\.bundle/i)).toBeInTheDocument()
    );
    fireEvent.click(
      screen.getByRole('button', { name: /open past uploads for creator bundle product/i })
    );

    expect(screen.getAllByRole('button', { name: /hold to delete upload/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /hold to delete upload/i }));

    await waitFor(() =>
      expect(deleteCreatorBackstageReleaseMock).toHaveBeenCalledWith({
        packageId: 'pkg.creator.bundle',
        deliveryPackageReleaseId: 'release_current',
      })
    );
    await waitFor(() => expect(screen.getByText('No package uploads yet')).toBeInTheDocument());
    await waitFor(() =>
      expect(
        screen.getByText(/Nothing is ready yet\. Use Upload a package to add the first product\./i)
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.queryByText(/Needs first install ID · 1 storefront · Gumroad/i)).toBeNull()
    );

    fireEvent.click(screen.getByRole('button', { name: /upload a package/i }));
    expect(screen.getByText(/Needs first upload/i)).toBeInTheDocument();
  });

  it('renames a package from the dashboard manager', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await openMoreTools();
    await expect(findExactTextNode('pkg.creator.bundle')).resolves.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /rename/i }));
    const input = screen.getByDisplayValue('Creator Bundle');
    fireEvent.change(input, { target: { value: 'Creator Bundle+' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(renameCreatorPackageMock.mock.calls[0]?.[0]).toEqual({
        packageId: 'pkg.creator.bundle',
        packageName: 'Creator Bundle+',
      })
    );
  });

  it('does not surface delete controls on the packages dashboard', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await openMoreTools();
    await expect(findExactTextNode('pkg.creator.bundle')).resolves.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.queryByText('Delete locked')).toBeNull();
  });

  it('keeps hidden packages collapsed by default when archived entries exist', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await openMoreTools();
    await waitFor(() =>
      expect(listCreatorPackagesMock).toHaveBeenCalledWith({ includeArchived: true })
    );
    await findExactTextNode('Hidden install IDs');
  });

  it('loads stored Backstage products first and then starts a live sync refresh', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await waitFor(() => expect(listCreatorBackstageProductsMock).toHaveBeenCalled());
    expect(listCreatorBackstageProductsMock.mock.calls[0]?.[0]).not.toMatchObject({
      liveSync: true,
    });
    await waitFor(() =>
      expect(
        listCreatorBackstageProductsMock.mock.calls.some(
          ([input]) =>
            typeof input === 'object' &&
            input !== null &&
            'liveSync' in input &&
            (input as { liveSync?: boolean }).liveSync === true
        )
      ).toBe(true)
    );
  });

  it('keeps hidden product links collapsed by default and lets visible links be hidden', async () => {
    const Component = PackagesRoute.options.component;
    if (!Component) {
      throw new Error('Packages route component is not defined');
    }

    render(<Component />, { wrapper: createWrapper() });

    await openMoreTools();
    await findExactTextNode('Hidden product links');
    const mergedProductLane = screen
      .getByText(/Install ID:\s*pkg\.creator\.bundle/i)
      .closest('.pm-product-row');
    expect(mergedProductLane).not.toBeNull();
    fireEvent.click(
      within(mergedProductLane as HTMLElement).getByRole('button', {
        name: /open past uploads for creator bundle product/i,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /hide link/i }));

    await waitFor(() =>
      expect(archiveCreatorBackstageProductMock).toHaveBeenCalledWith({
        catalogProductId: 'product_1',
      })
    );
  });
});
