// Page-number control used by the model grids.
import React from 'react';

/**
 * Page selector with at most ten visible page buttons.
 * @param {{currentPage: number, totalPages: number, handlePageChange: function(number): void}} props
 * @returns {JSX.Element} the pagination bar.
 */
function Pagination({ currentPage, totalPages, handlePageChange }) {
  const start = Math.max(1, currentPage - 5);
  const end = Math.min(start + 9, totalPages);

  return (
    <ul className="pagination justify-content-center">
      <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}>
        <a className="page-link" onClick={() => handlePageChange(1)}>
            &lt;&lt;
        </a>
      </li>
      <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}>
        <a className="page-link" onClick={() => handlePageChange(currentPage - 1)}>
          Previous
        </a>
      </li>
            {Array.from({ length: end - start + 1 }, (_, index) => (
        <li className={`page-item ${start + index === currentPage ? 'active' : ''}`} key={start + index}>
            <a className="page-link" onClick={() => handlePageChange(start + index)}>
            {start + index}
            </a>
        </li>
        ))}
        <li className={`page-item ${currentPage === totalPages ? 'disabled' : ''}`}>
        <a className="page-link" onClick={() => handlePageChange(currentPage + 1)}>
            Next
        </a>
        </li>
        <li className={`page-item ${currentPage === totalPages ? 'disabled' : ''}`}>
        <a className="page-link" onClick={() => handlePageChange(totalPages)}>
            &gt;&gt;
        </a>
        </li>
    </ul>
  );
}

export default Pagination;
