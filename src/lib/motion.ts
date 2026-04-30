import type { Transition, Variants } from "framer-motion";

export const transitions = {
  snap: { type: "spring", stiffness: 600, damping: 30 } as Transition,
  surface: { type: "spring", stiffness: 280, damping: 30 } as Transition,
  hero: { type: "spring", stiffness: 120, damping: 22 } as Transition,
  layout: { type: "tween", duration: 0.35, ease: [0.4, 0, 0.2, 1] } as Transition,
};

export const variants = {
  fadeUp: {
    hidden: { opacity: 0, y: 12 },
    show: { opacity: 1, y: 0, transition: transitions.surface },
    exit: { opacity: 0, y: -12, transition: transitions.snap },
  } as Variants,

  fadeIn: {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: transitions.surface },
    exit: { opacity: 0, transition: transitions.snap },
  } as Variants,

  scaleIn: {
    hidden: { opacity: 0, scale: 0.92 },
    show: { opacity: 1, scale: 1, transition: transitions.hero },
    exit: { opacity: 0, scale: 0.96, transition: transitions.snap },
  } as Variants,

  hot: {
    rest: { scale: 1 },
    pulse: {
      scale: [1, 1.04, 1],
      transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" },
    },
  } as Variants,

  voteTap: {
    rest: { scale: 1 },
    tap: { scale: 0.9, transition: transitions.snap },
  } as Variants,

  listItem: (i: number) => ({
    hidden: { opacity: 0, y: 8 },
    show: {
      opacity: 1,
      y: 0,
      transition: { ...transitions.surface, delay: i * 0.04 },
    },
  }),
};
