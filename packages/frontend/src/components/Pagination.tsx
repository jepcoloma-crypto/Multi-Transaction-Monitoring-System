interface PaginationProps {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}

export default function Pagination({ page, totalPages, total, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  const pages: (number | '...')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push('...');
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push('...');
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center justify-between pt-4 border-t">
      <p className="text-sm text-gray-500">{total} result(s)</p>
      <div className="flex items-center gap-1">
        <button onClick={() => onPageChange(page - 1)} disabled={page <= 1}
          className="px-3 py-1.5 rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed bg-gray-100 text-gray-700 hover:bg-gray-200">
          Prev
        </button>
        {pages.map((p, i) =>
          p === '...' ? (
            <span key={`dots-${i}`} className="px-2 py-1 text-sm text-gray-400">...</span>
          ) : (
            <button key={p} onClick={() => onPageChange(p)}
              className={`px-3 py-1.5 rounded-lg text-sm ${p === page ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {p}
            </button>
          )
        )}
        <button onClick={() => onPageChange(page + 1)} disabled={page >= totalPages}
          className="px-3 py-1.5 rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed bg-gray-100 text-gray-700 hover:bg-gray-200">
          Next
        </button>
      </div>
    </div>
  );
}
