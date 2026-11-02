// Disorders model page: sortable, paginated grid with fuse.js fuzzy search and result highlighting.
import './assets/css/style.css';
import { API_URL } from './config.js';
import './assets/css/base.css';
import 'bootstrap/dist/css/bootstrap.css';
import Pagination from './components/Pagination';
import { useState, useEffect } from 'react';
import Fuse from 'fuse.js'; // Import the Fuse library

/**
 * Disorders grid page.
 * @param {{title: object, data: object[]}} props model title/tile and the disorders loaded by App.
 * @returns {JSX.Element} the page.
 */
export function DisordersSearch({ title, data }) {
  const itemsPerPage = 9;
  const [currentPage, setCurrentPage] = useState(1);
  const [regularData, setRegularData] = useState([]);
  const [sortName, setSortName] = useState('name');
  const [state, setState] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const toggleOpen = () => setState(!state);
  const sortAttributes = ['causes', 'description', 'diagnosis', 'name', 'symptoms'];

  const [orderName, setOrderName] = useState('Ascending');
  const [orderState, setOrderState] = useState(false);
  const toggleOrderOpen = () => setOrderState(!orderState);
  const sortOrderAttributes = ['Ascending', 'Descending'];

  useEffect(() => {
    setRegularData(data);
  }, [data]);

  // Define an asynchronous function to fetch data from an API
  async function fetchDataFromAPI(apiUrl) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) {
        const responseData = await response.json();
        if (orderName === 'Descending') {
          responseData.reverse();
        }
        setRegularData(responseData);
      } else {
        console.error('Failed to fetch data from the API');
      }
    } catch (error) {
      console.error('An error occurred while fetching data:', error);
    }
  }

  useEffect(() => {
    if (sortName != null) {
      setState(false);
      var url = API_URL + '/get_all_' + title.title.toLowerCase() + '/?sort_by=' + sortName;
      console.log(url);
      fetchDataFromAPI(url);
    }
  }, [sortName]);

  useEffect(() => {
    setOrderState(false);
    regularData.reverse();
  }, [orderName]);

  const handlePageChange = (newPage) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setCurrentPage(newPage);
    }
  };

  useEffect(() => {
    const totalPages = Math.ceil(regularData.length / itemsPerPage);
    const start = Math.max(1, currentPage - 5);
    const end = Math.min(start + 9, totalPages);
    const visibleData = regularData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  }, [regularData, currentPage]);

  const allKeys = regularData.length > 0 ? Object.keys(regularData[0]) : [];

  const fuseOptions = {
    keys: allKeys,
    includeScore: true,
    threshold: 0.4,
  };
  const fuse = new Fuse(regularData, fuseOptions);

  const handleSearch = (e) => {
    e.preventDefault();
    const searchInput = e.target.elements.searchInput.value;
    setSearchQuery(searchInput);
  
    // Reset both data and current page to their initial values
    setRegularData(data);
    setCurrentPage(1);
  
    // Reinitialize Fuse with the original dataset
    const fuseOptions = {
      keys: allKeys, // Assuming allKeys is defined somewhere in your component
      includeScore: true,
      threshold: 0.4,
    };
    const newFuse = new Fuse(data, fuseOptions);
  
    if (searchInput.trim() !== '') {
      // Apply the new search using the newFuse instance
      const searchResults = newFuse.search(searchInput);
      const searchData = searchResults.map((result) => result.item);
      setRegularData(searchData);
    }
  };
  

  const totalPages = Math.ceil(regularData.length / itemsPerPage);
  const start = Math.max(1, currentPage - 5);
  const end = Math.min(start + 9, totalPages);
  const visibleData = regularData.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  return (
    <div>
      <h1 className="mt-5 text-center"> {title.title} </h1>
      <h2 className="mt-2 text-center"> Number of {title.title.toLowerCase()}: {regularData.length} </h2>
      <div className="mt-4 container">
        <form className="d-flex" role="search" onSubmit={handleSearch}>
          <input
            className="form-control me-2"
            type="search"
            name="searchInput"
            placeholder="Search"
            aria-label="Search"
          />
          <button className="btn btn-outline-primary" type="submit">
            Search
          </button>
        </form>
        <div class="mt-3 d-flex justify-content-around">
          <div class="dropdown">
            <button class="btn btn-secondary dropdown-toggle" type="button" id="dropdownMenuButton" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"
              onClick={toggleOpen}>
              Sort By: {sortName.charAt(0).toUpperCase()
                    + sortName.slice(1)}
            </button>
            { state ? 
              <div class="dropdown-menu mt-1 card position-absolute bg-white" style={{zIndex: '4'}}aria-labelledby="dropdownMenuButton">
                {sortAttributes.map((name) => (
                  <button class="dropdown-item" onClick={() => setSortName(name)}>{name.charAt(0).toUpperCase()
                    + name.slice(1)}</button>
                ))}
              </div> : null
            }
          </div>
          <div class="dropdown">
            <button class="btn btn-secondary dropdown-toggle" type="button" id="dropdownMenuButton" data-toggle="dropdown" aria-haspopup="true" aria-expanded="false"
              onClick={toggleOrderOpen}>
              Order By: {orderName}
            </button>
            { orderState ? 
              <div class="dropdown-menu mt-1 card position-absolute bg-white" style={{zIndex: '4'}}aria-labelledby="dropdownMenuButton">
                {sortOrderAttributes.map((name) => (
                  <button class="dropdown-item" onClick={() => setOrderName(name)}>{name}</button>
                ))}
              </div> : null
            }
          </div>
        </div>
      </div>
      <div className="mt-4 container">
        <Pagination currentPage={currentPage} totalPages={totalPages} handlePageChange={handlePageChange} />
      </div>
      <div className="container">
        <div className="row">
          {visibleData.map((element, index) => (
            <div className="col" style={{ width: '33%' }} key={index}>
              <title.tile data={element} id={element.id} query={searchQuery}></title.tile>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 container">
        <Pagination currentPage={currentPage} totalPages={totalPages} handlePageChange={handlePageChange} />
      </div>
    </div>
  );
}
