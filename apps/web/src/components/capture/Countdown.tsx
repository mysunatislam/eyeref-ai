import { AnimatePresence, motion } from "motion/react";

export function Countdown({ value }: { value: number | null }) {
  return (
    <AnimatePresence>
      {value !== null && value > 0 && (
        <motion.div
          key={value}
          initial={{ scale: 1.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="pointer-events-none absolute inset-0 grid place-items-center"
          aria-live="assertive"
        >
          <span className="num text-7xl font-semibold text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.6)]">
            {value}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
