/**
 * Compile-time surface of `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The DSH app publishes that package as browser runtime code only: `lib/index.js`
 * with its CSS Modules already bundled into the web shell's stylesheet, and no
 * `lib/types` at all. The plugin resolves the real package at runtime — through
 * the `node_modules` junction and the client bundle's external request — so this
 * file is a type-only stand-in and carries no runtime meaning.
 *
 * `tsconfig.json` maps the specifier here because an ambient `declare module`
 * cannot win over a successful resolution to a declaration-less `.js`
 * (TypeScript reports TS7016 instead). Only the exports the client modules
 * actually use are declared, with the prop names and defaults read off the
 * shipped bundle's JSDoc.
 */
import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  CSSProperties,
  ForwardRefExoticComponent,
  InputHTMLAttributes,
  MouseEventHandler,
  ReactElement,
  ReactNode,
  RefAttributes,
} from 'react'

/** A component usable in JSX: props in, one element (or nothing) out. */
type Fc<Props> = (props: Props) => ReactElement | null

/** Shared props for every icon component. */
export interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  readonly size?: number | undefined
  /** Extra class for layout placement; color rides `currentColor`. */
  readonly className?: string | undefined
}

/** One icon component: decorative, `aria-hidden`, colored by `currentColor`. */
export type IconComponent = Fc<IconProps>

export declare const IconCheckOutlineRegular: IconComponent
export declare const IconChevronDownOutlineRegular: IconComponent
export declare const IconInfoOutlineRegular: IconComponent
export declare const IconListPenOutlineRegular: IconComponent
export declare const IconPlusOutlineRegular: IconComponent
export declare const IconRefreshOutlineRegular: IconComponent
export declare const IconSearchOutlineRegular: IconComponent
export declare const IconTrashOutlineRegular: IconComponent
export declare const IconWarningOutlineRegular: IconComponent

/** Props of {@link Button}; native button attributes pass through. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual family; defaults to `ghost`. */
  readonly variant?: 'primary' | 'ghost' | 'outline' | 'toolbar' | undefined
  /** `md` is a 36px control, `sm` a 28px one. */
  readonly size?: 'md' | 'sm' | undefined
  /** Optional leading 16px icon node. */
  readonly icon?: ReactNode | undefined
}

/** A button; its ref is the native element. */
export declare const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>

/** Props of {@link Pill}: a 24px capsule chip, a button once `onClick` is set. */
export interface PillProps {
  readonly active?: boolean | undefined
  readonly className?: string | undefined
  readonly children?: ReactNode | undefined
  readonly onClick?: MouseEventHandler<HTMLElement> | undefined
  readonly title?: string | undefined
  readonly 'aria-haspopup'?: 'menu' | undefined
  readonly 'aria-expanded'?: boolean | undefined
}

export declare const Pill: Fc<PillProps>

/** Props of {@link Input}; input attributes pass through to the native input. */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Optional 16px leading icon node. */
  readonly icon?: ReactNode | undefined
}

export declare const Input: ForwardRefExoticComponent<InputProps & RefAttributes<HTMLInputElement>>

/** Props of {@link Switch}: a labelled 36x20 two-state toggle. */
export interface SwitchProps {
  readonly checked: boolean
  /** Called with the state the click asks for. */
  readonly onChange: (next: boolean) => void
  /** Localized accessible name; required, the control cannot ship unnamed. */
  readonly label: string
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
  readonly className?: string | undefined
}

export declare const Switch: Fc<SwitchProps>

/** Props of {@link Checkbox}: a labelled native checkbox. */
export interface CheckboxProps {
  readonly checked: boolean
  readonly onChange: (next: boolean) => void
  readonly label: ReactNode
  readonly disabled?: boolean | undefined
  readonly title?: string | undefined
  readonly className?: string | undefined
}

export declare const Checkbox: Fc<CheckboxProps>

/** Props of {@link Tag}: a read-only badge in one of eight palettes. */
export interface TagProps {
  readonly tone?: 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger' | undefined
  readonly className?: string | undefined
  readonly children?: ReactNode | undefined
}

export declare const Tag: Fc<TagProps>

/** One inline action a toast can append to its sentence. */
export interface ToastAction {
  /** Connective rendered before the label, e.g. 或. */
  readonly prefix?: string | undefined
  readonly label: string
  readonly onSelect: () => void
}

/** Props of {@link Toast}: a transient top-center banner. */
export interface ToastProps {
  readonly text: ReactNode
  readonly icon?: ReactNode | undefined
  readonly tone?: 'success' | undefined
  readonly anchor?: HTMLElement | null | undefined
  /** Full-opacity hold before the fade; defaults to 3000ms. */
  readonly holdMs?: number | undefined
  readonly actions?: readonly ToastAction[] | undefined
  /** Called once the fade completes; unmount the toast here. */
  readonly onDone?: (() => void) | undefined
}

export declare const Toast: Fc<ToastProps>

/** Props of {@link Modal}: a centered, body-portaled dialog. */
export interface ModalProps {
  readonly open: boolean
  /** Application close command, Escape, or mask click. */
  readonly onClose: () => void
  /** Dialog heading, also the accessible name. */
  readonly title: string
  readonly closeLabel: string
  readonly description?: string | undefined
  readonly children?: ReactNode | undefined
  /** Action row under the body. */
  readonly footer?: ReactNode | undefined
  readonly className?: string | undefined
  readonly contentClassName?: string | undefined
  readonly backdropBlur?: boolean | undefined
}

export declare const Modal: Fc<ModalProps>

/** Props of {@link MenuSurface}: the shared menu card material. */
export interface MenuSurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** Smaller corner radius for a compact menu. */
  readonly compact?: boolean | undefined
  readonly style?: CSSProperties | undefined
}

export declare const MenuSurface: ForwardRefExoticComponent<MenuSurfaceProps & RefAttributes<HTMLDivElement>>

/** Props of {@link MenuGroup}: one titled, sticky-headed section of menu rows. */
export interface MenuGroupProps {
  /** Caller-localized section heading. */
  readonly label: ReactNode
  readonly children?: ReactNode | undefined
}

export declare const MenuGroup: Fc<MenuGroupProps>

/**
 * Keep a scroll container's group headings opaque once they stick.
 * @param viewport - Unpadded, borderless scroll container with direct `MenuGroup` children.
 * @returns Cleanup owning the observers; call it before observing changed groups.
 */
export declare function observeStickyMenuGroups (viewport: HTMLElement): () => void
