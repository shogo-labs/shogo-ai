// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Account settings sheets wrap desktop Settings tab bodies. Text and
 * Lucide icons read this context so phone sheets bump type without
 * changing the web Settings page (context off).
 */
import {
  createContext,
  createElement,
  useMemo,
  useContext,
  type ComponentType,
  type ReactNode,
} from 'react'
import {
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
} from 'react-native'
import {
  ACCOUNT_SHEET_ICON_DEFAULT,
  remapAccountSheetTextClass,
  scaleAccountSheetIcon,
} from '../../lib/account-sheet-typography'

const AccountSheetChromeContext = createContext(false)

export function AccountSheetChromeProvider({
  children,
}: {
  children: ReactNode
}) {
  return (
    <AccountSheetChromeContext.Provider value={true}>
      {children}
    </AccountSheetChromeContext.Provider>
  )
}

export function useAccountSheetChrome(): boolean {
  return useContext(AccountSheetChromeContext)
}

export function AccountSheetText({ className, ...props }: TextProps) {
  const comfortable = useAccountSheetChrome()
  return (
    <Text
      {...props}
      className={
        comfortable ? remapAccountSheetTextClass(className) : className
      }
    />
  )
}

export function AccountSheetTextInput({ className, ...props }: TextInputProps) {
  const comfortable = useAccountSheetChrome()
  return (
    <TextInput
      {...props}
      className={
        comfortable ? remapAccountSheetTextClass(className) : className
      }
    />
  )
}

type IconProps = {
  size?: number
  [key: string]: unknown
}

export function accountSheetIcon<P extends IconProps>(
  Icon: ComponentType<P>,
): ComponentType<P> {
  function AccountSheetIcon(props: P) {
    const comfortable = useAccountSheetChrome()
    const base =
      typeof props.size === 'number' ? props.size : ACCOUNT_SHEET_ICON_DEFAULT
    const size = comfortable ? scaleAccountSheetIcon(base) : props.size
    return createElement(Icon, { ...props, size })
  }
  const name = Icon.displayName ?? Icon.name ?? 'Icon'
  AccountSheetIcon.displayName = `AccountSheet(${name})`
  return AccountSheetIcon
}

export function wrapAccountSheetIcons<
  T extends Record<string, ComponentType<IconProps>>,
>(icons: T): T {
  const wrapped = {} as T
  for (const key of Object.keys(icons) as Array<keyof T>) {
    wrapped[key] = accountSheetIcon(icons[key]) as T[keyof T]
  }
  return wrapped
}

export { AccountSheetText as Text, AccountSheetTextInput as TextInput }

export function useAccountSheetIcons<
  T extends Record<string, ComponentType<IconProps>>,
>(icons: T): T {
  return useMemo(() => wrapAccountSheetIcons(icons), [icons])
}
