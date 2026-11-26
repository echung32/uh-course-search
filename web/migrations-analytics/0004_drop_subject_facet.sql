-- The subject-growth chart (the only reader of facet = 'subject') was removed,
-- and computeTermRollups no longer writes those rows. Recompute's delete-stale
-- would purge them only for mutable terms, so drop them for every term here.
DELETE FROM term_facet_stats WHERE facet = 'subject';
