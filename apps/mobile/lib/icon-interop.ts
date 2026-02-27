/**
 * Registers all lucide-react-native icons with NativeWind's cssInterop
 * so that className color classes (e.g. text-purple-400, text-muted-foreground)
 * work correctly on web. Without this, SVG icons render with default black stroke.
 *
 * Import this file once at app startup (root _layout.tsx).
 */

import { cssInterop } from 'nativewind'
import {
  AlertCircle, AlertTriangle, AppWindow, ArrowDown, ArrowLeft,
  ArrowRight, ArrowUp, ArrowUpDown,
  BarChart3, Bell, BellOff, BookOpen, Bot, Building, Building2, Bookmark,
  Calendar, CalendarDays, Car, Check, CheckCircle, CheckCircle2,
  CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Clock, Copy, Cpu, CreditCard, Crown,
  Database, DollarSign, Download,
  Edit, ExternalLink, Eye, EyeOff,
  FileCode2, FilePlus, FileText, FolderKanban, FolderOpen, FolderPlus,
  Github, Globe, GripVertical,
  HardDrive, Heart, History, Home,
  Info,
  Key,
  Layout, LayoutDashboard, LayoutGrid, Layers, Link2, List, ListTree,
  Loader2, Lock, LogOut,
  Mail, MapPin, Menu, MessageSquare, Minus, Monitor, Moon,
  MoreHorizontal, MousePointer,
  Package, Palette, PanelLeft, PanelLeftClose, Pencil, Phone, Plane, Plus,
  RefreshCw,
  Save, ScrollText, Search, Server, Settings, Shield, Sparkles, Star,
  StarOff, Sun,
  Timer, Trash2, TrendingDown, TrendingUp, Type,
  Unlock, Upload, User, UserCircle, UserPlus, Users,
  WifiOff, Wrench,
  X, XCircle,
  Zap,
} from 'lucide-react-native'

const interopConfig = {
  className: {
    target: 'style',
    nativeStyleToProp: { color: true },
  },
} as const

const icons = [
  AlertCircle, AlertTriangle, AppWindow, ArrowDown, ArrowLeft,
  ArrowRight, ArrowUp, ArrowUpDown,
  BarChart3, Bell, BellOff, BookOpen, Bot, Building, Building2, Bookmark,
  Calendar, CalendarDays, Car, Check, CheckCircle, CheckCircle2,
  CheckSquare, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Clock, Copy, Cpu, CreditCard, Crown,
  Database, DollarSign, Download,
  Edit, ExternalLink, Eye, EyeOff,
  FileCode2, FilePlus, FileText, FolderKanban, FolderOpen, FolderPlus,
  Github, Globe, GripVertical,
  HardDrive, Heart, History, Home,
  Info,
  Key,
  Layout, LayoutDashboard, LayoutGrid, Layers, Link2, List, ListTree,
  Loader2, Lock, LogOut,
  Mail, MapPin, Menu, MessageSquare, Minus, Monitor, Moon,
  MoreHorizontal, MousePointer,
  Package, Palette, PanelLeft, PanelLeftClose, Pencil, Phone, Plane, Plus,
  RefreshCw,
  Save, ScrollText, Search, Server, Settings, Shield, Sparkles, Star,
  StarOff, Sun,
  Timer, Trash2, TrendingDown, TrendingUp, Type,
  Unlock, Upload, User, UserCircle, UserPlus, Users,
  WifiOff, Wrench,
  X, XCircle,
  Zap,
]

for (const icon of icons) {
  cssInterop(icon, interopConfig)
}
