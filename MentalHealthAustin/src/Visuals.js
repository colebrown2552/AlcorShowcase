// Data-visualization pages built with recharts and chart.js.
import './assets/css/style.css';
import './assets/css/base.css';
import React from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Scatter, ScatterChart, Bar, BarChart, Rectangle } from 'recharts';
import {
  Chart as ChartJS,
  ArcElement,
  Legend
} from 'chart.js';
import { Pie } from 'react-chartjs-2';
ChartJS.register(
  ArcElement, 
  Legend
);

/**
 * Landing page linking to the two visualization pages.
 * @returns {JSX.Element} the page.
 */
export function Visuals_landing(){
  return (<div>
    <section className="visuals display-flex">
      <div className="grid-container display-flex flex-column">
        <div className="grid-100 mobile-grid-100 tablet-grid-100 bubble text-align-center">
          <h1>
            Visualizations
          </h1>
        </div>
        <div className="mt-3 bubble">
          <Link to="/our_visuals" className="btn btn-primary rounded-pill"> Our Visuals </Link>
          <Link to="/developer_visuals" className="btn btn-primary rounded-pill ms-3"> Developer Visuals </Link>
        </div>
      </div>
    </section>
  </div>);
}

/**
 * Charts about this site's disorder, treatment and location data.
 * @param {{disorder_data: object[], treatment_data: object[], location_data: object[]}} props data from the API.
 * @returns {JSX.Element} the page.
 */
export function Our_visuals( {disorder_data, treatment_data, location_data} ){
  const CustomTooltipV1 = ({ active, payload, label }) => {
    if ( active && payload && payload.length ) {
      return (
        <div className="custom-tooltip">
          <p className="label">{`${label}`}</p>
          <p className="intro">{``}</p>
          <p className="desc">{`rating: ${payload[0].payload.rating}`}</p>
        </div>
      );
    }
    return null;
  };
  location_data.sort(function(a, b){return a.rating - b.rating}).reverse();
  const renderLineChart = (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart width={1200} height={400} data={location_data} margin={{top: 40}}>
            <text x={0} y={20} fontSize={20} fill="#333">
                Ratings per Location
            </text>
        <Line type="monotone" dataKey="rating" stroke="#8884d8" />
        <CartesianGrid stroke="#ccc" vertical={false}/>
        <YAxis axisLine={false} tickLine={false} ticks={[0, 1, 2, 3, 4, 5]} label={{ value: "Rating", angle: -90, position: "insideLeft", dy: 100}}/>
        <XAxis dataKey="name" tick={false} label={{ value: "Location Name", position: "insideBottom"}}/>
        <Tooltip content={CustomTooltipV1}/>
      </LineChart>
    </ResponsiveContainer>
  );


  const CustomTooltipV2 = ({ active, payload, label }) => {
    if ( active && payload && payload.length ) {
      return (
        <div className="custom-tooltip">
          <p className="label">{`${payload[0].payload.name}`}</p>
          <pre className="desc">{`address:    ${payload[0].payload.address} \nlongitude: ${payload[0].payload.longitude}\nlatitude:   ${payload[0].payload.latitude}`}</pre>
        </div>
      );
    }
    return null;
  };
  const renderScatterChart = (
    <ResponsiveContainer width="100%" height={600}>
        <ScatterChart margin={{ top: 40, right: 20, bottom: 20, left: 20 }}>
            <text x={0} y={20} fontSize={20} fill="#333">
                Locations based on Latitude/Longitude
            </text>
          <Scatter name="Locations" data={location_data} fill="#11e7c9" shape="wye"/>
          <CartesianGrid hide={true}/>
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={CustomTooltipV2} position={{x:100, y:140}}/>
          <YAxis dataKey="latitude" type="number" name="latitude" domain={[30.15, 30.55]} allowDataOverflow={true} 
            label={{ value: "Latitude", angle: -90, position: "insideLeft"}}
            tick={{ fontSize: 10 }}/>
          <XAxis dataKey="longitude" type="number" name="longitude" domain={[-97.87, -97.7]} allowDataOverflow={true} 
            label={{ value: "Longitude", position: "insideBottom", offset: -10 }}
            tick={{ fontSize: 10 }}/>
        </ScatterChart>
    </ResponsiveContainer>
  );

  const renderBarChart = (
    <ResponsiveContainer width="100%" height={600}>
        <BarChart width={150} height={40} data={treatment_data
        .filter((item) => item.disorders_list)
        .map((item) => ({
            name: item.title.toLowerCase().split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "),
            disorderCount: item.disorders_list.length,
        }))
        .filter((item) => item.disorderCount > 1)
        .slice(0, 50)} 
            margin={{ top: 40, right: 30, left : 20, bottom: 5, }}>
                <text x={0} y={20} fontSize={20} fill="#333">
                    Number of Disorders Treated per Treatment
                </text>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" tick={false} label={{ value: "Treatment Name", position: "insideBottom"}}/>
            <YAxis label={{ value: "Number of Disorders Served", angle: -90, position: "insideLeft", dy: 100 }}/>
            <Tooltip />
            <Legend />
            <Bar dataKey="disorderCount" fill="#8884d8" activeBar={<Rectangle fill="gold" stroke="blue" />} />
            {console.log(treatment_data)}
        </BarChart>
    </ResponsiveContainer>
  );
  
  return (
    <div className="mt-3 container">
      <div className="visual 1">
        <pre />
        <pre />
        {renderLineChart}
        <pre />
        <pre />
        <pre />
        <pre />
      </div>
      <div>
        {renderScatterChart}
        <pre />
        <pre />
        <pre />
        <pre />
      </div>
      <div>
        {renderBarChart}
        <pre />
        <pre />
        <pre />
      </div>
    </div>
  );
}

/**
 * Charts about a partner project's nonprofit data (empty unless REACT_APP_NONPROFIT_API_URL is set).
 * @param {{non_profit_data: object[]}} props category counts.
 * @returns {JSX.Element} the page.
 */
export function Developer_visuals({non_profit_data, treatment_data, location_data}){
  var names = [];
  var numbers = [];
  const COLORS = ['orange', 'fuchsia', 'green', 'yellow', 'navy', 'green', 'maroon', 'red', 'purple', 'aqua', 'olive', 'silver', 'blue'];

  for (var i = 0; i < non_profit_data.length; i++) {
    names.push(non_profit_data[i].name);
    numbers.push(non_profit_data[i].value);
  }
 
  const [pieprops, setPieProps] = React.useState({
    labels: names,
    datasets: [
      {
        data: numbers,
        backgroundColor: COLORS
      }
    ]
  }, [non_profit_data]); 
  
  const options = {
    responsive: true
  };

  /*
  for (var i = 0; i < non_profit_data.length; i++) {
    var obj = non_profit_data[i];
    obj['fill'] = COLORS[i];
  }*/

  return (
    <div>
      <div>
        visual 1
      </div>
      <div>
        <h5 className="ms-5">
          Number of Non-profits per Category
        </h5>
        <div className='ms-auto me-auto' style={{ width: '50%', height: 600 }}>
          <Pie data={pieprops}
              options={options}
              >
          </Pie> 
        </div>
      </div>
      <div>
        visual 3
      </div>
    </div>
  );
}