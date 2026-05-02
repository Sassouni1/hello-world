CREATE TABLE public.counter (
  id INT PRIMARY KEY DEFAULT 1,
  value INT NOT NULL DEFAULT 0,
  CONSTRAINT single_row CHECK (id = 1)
);

ALTER TABLE public.counter ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view counter" ON public.counter FOR SELECT USING (true);
CREATE POLICY "Anyone can update counter" ON public.counter FOR UPDATE USING (true);

INSERT INTO public.counter (id, value) VALUES (1, 0);