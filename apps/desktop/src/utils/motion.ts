import type { Transition, Variants } from "motion/react";

/**
 * Emil Kowalski Craft Standard Spring Physics & Transition Tokens
 * Enforces 60/120 FPS hardware-accelerated micro-interactions
 */
export const springs = {
  // Snappy: For toggles, micro-buttons, checkboxes, tab indicators
  snappy: { type: "spring", stiffness: 500, damping: 35, mass: 0.8 } as Transition,

  // Interactive (Default): For dropdowns, popovers, drawers, hover cards
  interactive: { type: "spring", stiffness: 400, damping: 30 } as Transition,

  // Smooth / Large: For full modals, page sheets, expanding cards
  smooth: { type: "spring", stiffness: 300, damping: 32 } as Transition,

  // Bouncy / Playful: For celebration badges, live alerts
  bouncy: { type: "spring", stiffness: 400, damping: 18 } as Transition,
} as const;

// Tactile Press & Hover Micro-Interactions
export const microMotion = {
  tapScale: { scale: 0.97 },
  tapScaleSubtle: { scale: 0.985 },
  tapBounce: { scale: 0.95 },
  hoverLift: { y: -1.5 },
  hoverScale: { scale: 1.02 },
  hoverCard: { y: -2, scale: 1.008 },
};

// Modal Backdrop Fade
export const backdropVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: { duration: 0.2, ease: "easeOut" } },
  exit: { opacity: 0, transition: { duration: 0.15, ease: "easeIn" } },
};

// Center Modal Spring Zoom
export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.95, y: 12 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springs.smooth,
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: 8,
    transition: { duration: 0.14, ease: "easeIn" },
  },
};

// Right Slide-Over Inspector Drawer
export const drawerVariants: Variants = {
  initial: { x: "100%", opacity: 0.5 },
  animate: {
    x: 0,
    opacity: 1,
    transition: springs.smooth,
  },
  exit: {
    x: "100%",
    opacity: 0,
    transition: { duration: 0.2, ease: "easeInOut" },
  },
};

// Popover / Speed Throttle Dial
export const popoverVariants: Variants = {
  initial: { opacity: 0, scale: 0.93, y: 8 },
  animate: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: springs.interactive,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 4,
    transition: { duration: 0.12, ease: "easeIn" },
  },
};

// View Switcher (Downloads <-> Settings)
export const viewVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: springs.smooth,
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.15, ease: "easeIn" },
  },
};

// Tab Pane Switcher
export const tabPaneVariants: Variants = {
  initial: { opacity: 0, x: 8 },
  animate: {
    opacity: 1,
    x: 0,
    transition: springs.interactive,
  },
  exit: {
    opacity: 0,
    x: -8,
    transition: { duration: 0.12, ease: "easeIn" },
  },
};

// Staggered Download List
export const listContainerVariants: Variants = {
  initial: {},
  animate: {
    transition: {
      staggerChildren: 0.035,
    },
  },
};

export const listItemVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: springs.snappy,
  },
  exit: {
    opacity: 0,
    scale: 0.97,
    transition: { duration: 0.12 },
  },
};
