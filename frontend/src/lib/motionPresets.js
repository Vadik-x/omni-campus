const easeOutQuint = [0.22, 1, 0.36, 1];

export const pageVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.42, ease: easeOutQuint },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: { duration: 0.2, ease: "easeInOut" },
  },
};

export const panelVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.32, ease: easeOutQuint },
  },
};

export const staggerContainerVariants = {
  hidden: { opacity: 1 },
  visible: {
    opacity: 1,
    transition: {
      delayChildren: 0.04,
      staggerChildren: 0.06,
    },
  },
};

export const staggerItemVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.26, ease: easeOutQuint },
  },
};

export const kpiCardVariants = {
  hidden: { opacity: 0, y: 14, scale: 0.992 },
  visible: (index = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      duration: 0.34,
      delay: index * 0.05,
      ease: easeOutQuint,
    },
  }),
};

export const toastVariants = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.24, ease: easeOutQuint },
  },
  exit: {
    opacity: 0,
    y: 12,
    transition: { duration: 0.18, ease: "easeInOut" },
  },
};
