-- The product is Kriya Tavi: plan text seeded by the core migration still
-- said "Kriya Bots"
update kriya.plans
  set description = replace(description, 'Kriya Bots', 'Kriya Tavi')
  where description like '%Kriya Bots%';
